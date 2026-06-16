/**
 * Channel-agnostic "message the owner" for proactive notifications (morning
 * brief, weekly-review nudge, reminders). Prefers Telegram (free, no carrier
 * gatekeeping); falls back to SMS if only that's configured.
 */
export async function notifyOwner(text: string): Promise<{ ok: boolean; channel?: string; error?: string }> {
  // Telegram first.
  try {
    const tg = await import("./telegram");
    if (tg.telegramEnabled() && tg.ownerChatId()) {
      await tg.sendTelegram(tg.ownerChatId()!, text);
      return { ok: true, channel: "telegram" };
    }
  } catch (err) {
    console.error("notifyOwner telegram failed", err);
  }
  // SMS fallback.
  try {
    const sms = await import("./sms");
    if (sms.smsEnabled() && sms.ownerPrimaryPhone()) {
      await sms.sendSms(sms.ownerPrimaryPhone()!, text);
      return { ok: true, channel: "sms" };
    }
  } catch (err) {
    console.error("notifyOwner sms failed", err);
  }
  return { ok: false, error: "No messaging channel configured." };
}

export async function ownerReachable(): Promise<boolean> {
  const tg = await import("./telegram");
  if (tg.telegramEnabled() && tg.ownerChatId()) return true;
  const sms = await import("./sms");
  return sms.smsEnabled() && !!sms.ownerPrimaryPhone();
}
