/**
 * Telegram bridge — message Scout from the Telegram app, Scout replies.
 * No carrier registration, no fees. Dormant until TELEGRAM_BOT_TOKEN is set.
 *
 * Env:
 *  - TELEGRAM_BOT_TOKEN          — from BotFather
 *  - TELEGRAM_ALLOWED_CHAT_IDS   — comma-separated chat IDs allowed to talk to Scout (just Selena)
 *  - TELEGRAM_WEBHOOK_SECRET     — random string; Telegram echoes it back so we can verify requests
 */

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN;

export function telegramEnabled(): boolean {
  return !!TOKEN();
}

export function allowedChatIds(): string[] {
  return (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Only Selena's chat(s) may talk to Scout. If none configured yet, allow (setup phase). */
export function isAllowedChat(chatId: number | string): boolean {
  const ids = allowedChatIds();
  if (ids.length === 0) return true; // pre-allowlist setup window
  return ids.includes(String(chatId));
}

export function ownerChatId(): string | null {
  return allowedChatIds()[0] ?? null;
}

/** Verify Telegram's secret-token header so only Telegram can hit our webhook. */
export function webhookSecretOk(header: string | null): boolean {
  const s = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!s) return true; // no secret configured → skip check
  return header === s;
}

export async function sendTelegram(chatId: number | string, text: string): Promise<void> {
  if (!telegramEnabled()) throw new Error("Telegram not configured.");
  const res = await fetch(`https://api.telegram.org/bot${TOKEN()}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Telegram send ${res.status}: ${t.slice(0, 200)}`);
  }
}
