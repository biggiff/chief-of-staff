import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { generateChiefResponse } from "@/lib/chat-engine";
import { telegramEnabled, isAllowedChat, webhookSecretOk, sendTelegram } from "@/lib/integrations/telegram";

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
  const text = (msg?.text ?? "").trim();
  const chatId = msg?.chat?.id;
  if (!chatId || !text) return ok();
  if (!isAllowedChat(chatId)) return ok(); // only Selena

  // "/start" is Telegram's first-tap — greet without running the full brain.
  if (/^\/start\b/.test(text)) {
    after(() => sendTelegram(chatId, "Hey, it's Scout. Text me anything — add a task, a grocery item, a reminder, or ask what's on your plate.").catch(() => {}));
    return ok();
  }

  const conversationId = await getTelegramConversationId();
  const prior = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(10);
  const history = prior.reverse().map((m) => ({ role: m.role, content: m.content }));
  await db.insert(messages).values({ conversationId, role: "user", content: text });

  // Generate + reply after the webhook returns (deep questions get an ack first).
  after(async () => {
    try {
      const reply = await generateChiefResponse(text, history, conversationId);
      await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
      await sendTelegram(chatId, reply.content);
      // Keep the Todoist mirror fresh for the Telegram channel too (the web route
      // already does this) so retrieval stays current. Throttled internally.
      try {
        const { syncTodoistIfStale } = await import("@/lib/integrations/todoist");
        await syncTodoistIfStale();
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
