import crypto from "node:crypto";

/**
 * SMS bridge (Twilio) — text Scout, Scout texts back. Dormant until the env vars
 * are set, so the app deploys safely without it.
 *
 * Env:
 *  - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN  — account credentials
 *  - TWILIO_FROM_NUMBER                     — Scout's number (E.164, e.g. +16025551234)
 *  - OWNER_PHONE_NUMBERS                    — comma-separated allowlist (E.164); only these can text Scout
 *  - TWILIO_WEBHOOK_URL (optional)          — exact public URL Twilio POSTs to (for signature validation behind a proxy)
 */

const SID = () => process.env.TWILIO_ACCOUNT_SID;
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN;
const FROM = () => process.env.TWILIO_FROM_NUMBER;

export function smsEnabled(): boolean {
  return !!(SID() && TOKEN() && FROM());
}

/** Just the digits — so "+1 (602) 555-1234", "16025551234", "6025551234" all compare equal. */
function digits(n: string): string {
  return (n || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}

export function ownerPhones(): string[] {
  return (process.env.OWNER_PHONE_NUMBERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is this sender allowed to talk to Scout? (Only Selena's number(s).) */
export function isAllowedSender(from: string): boolean {
  const f = digits(from);
  return ownerPhones().some((p) => digits(p) === f) && !!f;
}

/** The owner's primary number, for proactive (outbound) messages. */
export function ownerPrimaryPhone(): string | null {
  return ownerPhones()[0] ?? null;
}

/** Send an SMS via the Twilio REST API (basic auth, no SDK needed). Prefers the
 *  A2P-registered Messaging Service when configured (better deliverability). */
export async function sendSms(to: string, body: string): Promise<void> {
  if (!smsEnabled()) throw new Error("SMS not configured.");
  const auth = Buffer.from(`${SID()}:${TOKEN()}`).toString("base64");
  const params: Record<string, string> = { To: to, Body: body.slice(0, 1500) };
  const mss = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (mss) params.MessagingServiceSid = mss;
  else params.From = FROM()!;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID()}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Twilio send ${res.status}: ${t.slice(0, 200)}`);
  }
}

/**
 * Validate Twilio's X-Twilio-Signature so a stranger can't POST to our webhook
 * pretending to be Twilio (the allowlist checks the From field, which a raw POST
 * could forge — the signature can't be forged without our auth token).
 */
export function validateTwilioSignature(url: string, params: Record<string, string>, signature: string | null): boolean {
  const token = TOKEN();
  if (!token) return false;
  if (!signature) return false;
  // Twilio: signature = base64( HMAC-SHA1( authToken, url + sorted(key+value)... ) )
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
