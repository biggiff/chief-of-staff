import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { generateChiefResponse } from "@/lib/chat-engine";
import { isQuickRequest } from "@/lib/ai";
import { smsEnabled, isAllowedSender, validateTwilioSignature, sendSms } from "@/lib/integrations/sms";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SMS_TITLE = "📱 Texts";

// Empty TwiML — we reply out-of-band via the REST API (so a slow turn never hits
// Twilio's ~15s webhook timeout). Always 200 so Twilio doesn't retry.
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const xml = (body = EMPTY_TWIML) =>
  new NextResponse(body, { status: 200, headers: { "Content-Type": "text/xml" } });

async function getSmsConversationId(): Promise<string> {
  const [existing] = await db.select().from(conversations).where(eq(conversations.title, SMS_TITLE)).limit(1);
  if (existing) {
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, existing.id));
    return existing.id;
  }
  const [conv] = await db.insert(conversations).values({ title: SMS_TITLE }).returning();
  return conv.id;
}

export async function POST(req: NextRequest) {
  if (!smsEnabled()) return xml(); // dormant until configured

  const form = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = v.toString();

  // Verify the request genuinely came from Twilio (signature can't be forged).
  const url = process.env.TWILIO_WEBHOOK_URL || `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("host")}${req.nextUrl.pathname}`;
  const sig = req.headers.get("x-twilio-signature");
  if (!validateTwilioSignature(url, params, sig)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const from = params.From ?? "";
  const body = (params.Body ?? "").trim();
  // Only Selena can talk to Scout. Silently ignore anyone else.
  if (!isAllowedSender(from) || !body) return xml();

  const conversationId = await getSmsConversationId();
  const prior = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  const history = prior.reverse().map((m) => ({ role: m.role, content: m.content }));

  await db.insert(messages).values({ conversationId, role: "user", content: body });

  // Generate + send the reply AFTER the webhook returns, so slow turns never time
  // out the webhook. Deep questions get an instant "on it" ack first.
  after(async () => {
    try {
      if (!isQuickRequest(body)) {
        await sendSms(from, "On it — give me a sec.").catch(() => {});
      }
      const reply = await generateChiefResponse(body, history, conversationId);
      await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
      await sendSms(from, reply.content);
    } catch (err) {
      console.error("sms turn failed", err);
      await sendSms(from, "Something hiccuped on my end — try that again?").catch(() => {});
    }
  });

  return xml();
}
