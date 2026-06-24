import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { fastGrocery, generateAIResponse } from "@/lib/ai";
import { aiEnabled } from "@/lib/ai";
import { generateChiefResponse } from "@/lib/chat-engine";
import { telegramEnabled, isAllowedChat, webhookSecretOk, sendTelegram, sendTelegramMessage, editTelegramMessage, getTelegramFile } from "@/lib/integrations/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TG_TITLE = "💬 Telegram";

async function getTelegramConversationId(): Promise<string> {
  const [existing] = await db.select().from(conversations).where(eq(conversations.title, TG_TITLE)).limit(1);
  if (existing) {
    await db.update(conversations).set({ updatedAt: new Date() }).where(eq(conversations.id, existing.id));
    return existing.id;
  }
  const [conv] = await db.insert(conversations).values({ title: TG_TITLE }).returning();
  return conv.id;
}

export async function POST(req: NextRequest) {
  // Always 200 so Telegram doesn't retry/disable the webhook.
  const ok = () => NextResponse.json({ ok: true });
  if (!telegramEnabled()) return ok();
  if (!webhookSecretOk(req.headers.get("x-telegram-bot-api-secret-token"))) {
    return new NextResponse("forbidden", { status: 403 });
  }

  const update = await req.json().catch(() => null);
  const msg = update?.message ?? update?.edited_message;
  const chatId = msg?.chat?.id;
  if (!chatId) return ok();
  if (!isAllowedChat(chatId)) return ok(); // only Selena

  const text = (msg?.text ?? "").trim();
  const caption = (msg?.caption ?? "").trim();
  // Largest photo size, or an image sent as a document.
  const photo = Array.isArray(msg?.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
  const imageDoc = msg?.document && /^image\//.test(msg.document.mime_type || "") ? msg.document : null;
  const imageFileId: string | null = photo?.file_id ?? imageDoc?.file_id ?? null;
  const isVoice = !!(msg?.voice || msg?.audio || msg?.video_note);

  // "/start" is Telegram's first-tap — greet without running the full brain.
  if (/^\/start\b/.test(text)) {
    after(() => sendTelegram(chatId, "Hey, it's Scout. Text me anything — add a task, a grocery item, a reminder, send a photo, or ask what's on your plate.").catch(() => {}));
    return ok();
  }

  // Voice memos aren't supported yet (needs a transcription service).
  if (isVoice && !imageFileId && !text) {
    after(() => sendTelegram(chatId, "I can't listen to voice memos yet — type it out and I'm on it. (I can add voice transcription if you want it.)").catch(() => {}));
    return ok();
  }

  const userText = caption || text;
  if (!imageFileId && !userText) return ok(); // nothing actionable

  const conversationId = await getTelegramConversationId();
  const prior = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  const history = prior.reverse().map((m) => ({ role: m.role, content: m.content }));
  await db.insert(messages).values({ conversationId, role: "user", content: userText || "📷 Photo" });

  // Generate + reply after the webhook returns.
  after(async () => {
    try {
      // Download the image (if any) so Scout can actually see it.
      let image: { data: string; mediaType: string } | undefined;
      if (imageFileId) {
        const f = await getTelegramFile(imageFileId).catch(() => null);
        if (f) image = f;
      }

      // Instant deterministic grocery adds — text-only, no model/streaming.
      const groc = !image && aiEnabled() ? await fastGrocery(userText) : null;
      if (groc) {
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: groc.content, metadataJson: groc.metadata });
        await sendTelegram(chatId, groc.content);
      } else if (aiEnabled()) {
        // STREAM: send a placeholder, then live-edit it as the answer generates.
        const msgId = await sendTelegramMessage(chatId, image ? "👀 looking…" : "…").catch(() => null);
        // Edits are SERIALIZED through a single chain (and throttled), so a stray
        // mid-stream partial can never land after the final complete text.
        let chain: Promise<void> = Promise.resolve();
        let last = 0;
        const prompt = userText || "Take a look at this photo — what is it, and is there anything I should capture or do with it?";
        const reply = await generateAIResponse(prompt, history, conversationId, image, (acc) => {
          const now = Date.now();
          if (msgId && acc && now - last > 1300) {
            last = now;
            chain = chain.then(() => editTelegramMessage(chatId, msgId, acc));
          }
        });
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
        if (msgId) {
          await chain; // let any queued partial edits finish first
          await editTelegramMessage(chatId, msgId, reply.content || "…"); // final wins
        } else {
          await sendTelegram(chatId, reply.content);
        }
      } else {
        // No AI key — rule-based fallback.
        const reply = await generateChiefResponse(userText, history, conversationId);
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
        await sendTelegram(chatId, reply.content);
      }
      // Keep the Todoist mirror fresh for the Telegram channel (throttled).
      try {
        const { syncTodoistIfStale } = await import("@/lib/integrations/todoist");
        await syncTodoistIfStale(2); // keep the mirror within ~2 min of Todoist for context signals
      } catch (err) {
        console.error("telegram post-reply sync failed", err);
      }
    } catch (err) {
      console.error("telegram turn failed", err);
      await sendTelegram(chatId, "Something hiccuped on my end — try that again?").catch(() => {});
    }
  });

  return ok();
}
