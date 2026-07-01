import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { eq, desc } from "drizzle-orm";
import { db, conversations, messages } from "@/db";
import { fastGrocery, fastDevNote, generateAIResponse } from "@/lib/ai";
import { aiEnabled } from "@/lib/ai";
import { generateChiefResponse } from "@/lib/chat-engine";
import { telegramEnabled, isAllowedChat, webhookSecretOk, sendTelegram, sendTelegramMessage, editTelegramMessage, getTelegramFile } from "@/lib/integrations/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const TG_TITLE = "💬 Telegram";

// A text-only message that's plainly pointing at an image she just sent.
const REFERS_TO_IMAGE = /\b(this|that|these|those|it|pic|picture|photo|image|invite|invitation|flyer|screenshot|the (?:one|thing))\b/i;

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
  let imageFileId: string | null = photo?.file_id ?? imageDoc?.file_id ?? null;
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

  // If she used Telegram's Reply/quote on an earlier message, capture WHAT she's
  // pointing at so Scout knows the reference even if it scrolled out of history.
  const quoted = msg?.reply_to_message;
  const quotedText = ((quoted?.text ?? quoted?.caption ?? "") as string).trim();
  const effectivePrompt = quotedText
    ? `[She tapped Reply on this earlier message, so she's referring to it:\n"${quotedText.slice(0, 600)}"]\n\n${userText || "(no new text — she's pointing at the quoted message above)"}`
    : userText;

  const conversationId = await getTelegramConversationId();
  const prior = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(24); // wider window so references reach back ~12 exchanges, not ~5
  const history = prior.reverse().map((m) => ({ role: m.role, content: m.content }));
  await db.insert(messages).values({ conversationId, role: "user", content: userText || "📷 Photo" });

  // Generate + reply after the webhook returns.
  after(async () => {
    let imageRecalled = false;
    try {
      // Image memory: remember the last image she sent, and if a later text-only
      // message refers to an image ("add this", "from the picture") within a short
      // window, re-attach it — so a follow-up about an image she sent moments ago
      // doesn't make Scout guess (or invent an event) because the image was on a
      // separate message.
      try {
        const { getSetting, setSetting } = await import("@/lib/operator");
        if (imageFileId) {
          await setSetting("tg_last_image", `${imageFileId}|${Date.now()}`);
        } else if (REFERS_TO_IMAGE.test(userText)) {
          const [fid, ts] = ((await getSetting("tg_last_image")) || "").split("|");
          if (fid && ts && Date.now() - parseInt(ts, 10) < 15 * 60 * 1000) {
            imageFileId = fid;
            imageRecalled = true;
          }
        }
      } catch (err) {
        console.error("image recall failed", err);
      }

      // Download the image (if any) so Scout can actually see it.
      let image: { data: string; mediaType: string } | undefined;
      if (imageFileId) {
        const f = await getTelegramFile(imageFileId).catch(() => null);
        if (f) image = f;
        else if (imageRecalled) imageRecalled = false; // recall failed → don't claim we have it
      }

      // Instant deterministic shortcuts (text-only): dev/bug notes win first, then
      // grocery adds — both bypass the model so a food word can't be mis-routed.
      const fast = !image && aiEnabled() ? (await fastDevNote(userText, conversationId)) ?? (await fastGrocery(userText)) : null;
      if (fast) {
        // These deterministic shortcuts skip the model, so they'd otherwise miss the
        // status label. Prepend it so the "a label = Scout really did it" rule holds
        // everywhere — no silent actions.
        const label = fast.metadata?.engine === "fast-devnote" ? "🛠️ Saved a dev note"
          : fast.metadata?.engine === "fast-grocery" ? "🛒 Updated your grocery list"
          : null;
        const content = label ? `${label}\n—\n${fast.content}` : fast.content;
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content, metadataJson: fast.metadata });
        await sendTelegram(chatId, content);
      } else if (aiEnabled()) {
        // STREAM with a stay-visible "working" trail: status lines (one per tool,
        // generated in code — no extra tokens) accumulate above the final answer,
        // so she sees what Scout actually did. Edits are SERIALIZED + de-duped so a
        // stray partial can't land after the final, and identical edits are skipped.
        const msgId = await sendTelegramMessage(chatId, image ? "👀 looking…" : "…").catch(() => null);
        let chain: Promise<void> = Promise.resolve();
        let lastEdit = 0;
        let lastSent = "";
        const steps: string[] = [];
        let answer = "";
        const render = () => {
          const trail = steps.join("\n");
          const body = answer.trim();
          return [trail, body].filter(Boolean).join(trail && body ? "\n—\n" : "") || "…";
        };
        const pushEdit = (force = false) => {
          if (!msgId) return;
          const now = Date.now();
          if (!force && now - lastEdit < 1000) return;
          const snapshot = render();
          if (snapshot === lastSent) return;
          lastEdit = now;
          lastSent = snapshot;
          chain = chain.then(() => editTelegramMessage(chatId, msgId, snapshot));
        };
        const base = effectivePrompt || "Take a look at this photo — what is it, and is there anything I should capture or do with it?";
        const prompt = imageRecalled ? `(Using the image she sent a moment ago — it's attached.)\n\n${base}` : base;
        const reply = await generateAIResponse(
          prompt,
          history,
          conversationId,
          image,
          (acc) => { answer = acc; pushEdit(); },
          (label) => { if (steps[steps.length - 1] !== label) steps.push(label); answer = ""; pushEdit(true); }
        );
        await db.insert(messages).values({ conversationId, role: "chief_of_staff", content: reply.content, metadataJson: reply.metadata });
        const finalText = steps.length
          ? `${steps.join("\n")}\n—\n${reply.content || "Done."}`
          : reply.content || "…";
        if (msgId) {
          await chain; // let queued edits finish first
          if (finalText !== lastSent) await editTelegramMessage(chatId, msgId, finalText); // trail + answer wins
        } else {
          await sendTelegram(chatId, finalText);
        }
      } else {
        // No AI key — rule-based fallback.
        const reply = await generateChiefResponse(effectivePrompt || userText, history, conversationId);
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
