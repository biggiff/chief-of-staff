/**
 * Minimal single-password gate.
 *
 * Edge-safe (uses only Web Crypto + TextEncoder) so it can run in middleware.
 * When APP_PASSWORD is unset (e.g. local dev), the gate is disabled entirely.
 * The cookie holds a SHA-256 token derived from the password, so it can't be
 * forged without knowing it, and the raw password is never stored in the cookie.
 */

export const AUTH_COOKIE = "cos_auth";

export function authEnabled(): boolean {
  return !!process.env.APP_PASSWORD;
}

export async function expectedToken(): Promise<string> {
  const secret = process.env.APP_PASSWORD || "";
  const data = new TextEncoder().encode(`cos-auth:v1:${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
