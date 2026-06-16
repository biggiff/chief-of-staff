import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { fastGrocery, generateAIResponse } from "@/lib/ai";
import { aiEnabled } from "@/lib/ai";
import { generateChiefResponse } from "@/lib/chat-engine";
import { telegramEnabled, isAllowedChat, webhookSecretOk, sendTelegram, sendTelegramMessage, editTelegramMessage } from "@/lib/integrations/telegram";

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

  // Generate + reply after the webhook returns.
  after(async () => {
    try {
      // Instant deterministic grocery adds — no model, no streaming needed.
      const groc = aiEnabled() ? await fastGrocery(text) : null;
      if (groc) {
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: groc.content, metadataJson: groc.metadata });
        await sendTelegram(chatId, groc.content);
      } else if (aiEnabled()) {
        // STREAM: send a placeholder, then live-edit it as the answer generates.
        const msgId = await sendTelegramMessage(chatId, "…").catch(() => null);
        let last = 0;
        let lastText = "";
        const reply = await generateAIResponse(text, history, conversationId, undefined, (acc) => {
          lastText = acc;
          const now = Date.now();
          // Throttle edits to ~1.3s apart to stay well under Telegram's rate limit.
          if (msgId && acc && now - last > 1300) {
            last = now;
            void editTelegramMessage(chatId, msgId, acc);
          }
        });
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
        // Final state: make sure the message shows the complete answer.
        if (msgId && reply.content && reply.content !== lastText) {
          await editTelegramMessage(chatId, msgId, reply.content);
        } else if (!msgId) {
          await sendTelegram(chatId, reply.content);
        }
      } else {
        // No AI key — rule-based fallback.
        const reply = await generateChiefResponse(text, history, conversationId);
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
        await sendTelegram(chatId, reply.content);
      }
      // Keep the Todoist mirror fresh for the Telegram channel (throttled).
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
