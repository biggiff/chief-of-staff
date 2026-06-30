/**
 * Kroger / Fry's integration. Two token types:
 *  - client-credentials (app token, scope product.compact) → search products + find stores
 *  - authorization-code (user token, scope cart.basic:write) → add items to HER cart
 * The user refresh token lives in app_settings (NOT env) because Kroger ROTATES it
 * on every refresh, so we must be able to write the new one back. Dormant until
 * KROGER_CLIENT_ID / KROGER_CLIENT_SECRET are set (and she's authorized for cart).
 */
import { getSetting, setSetting } from "../operator";

const BASE = "https://api.kroger.com/v1";
const TOKEN_URL = `${BASE}/connect/oauth2/token`;
export const KROGER_AUTHORIZE_URL = `${BASE}/connect/oauth2/authorize`;
export const KROGER_REDIRECT = "http://localhost:4567/callback";

const CID = () => process.env.KROGER_CLIENT_ID;
const SECRET = () => process.env.KROGER_CLIENT_SECRET;

export function krogerEnabled(): boolean {
  return !!(CID() && SECRET());
}
const basicAuth = () => "Basic " + Buffer.from(`${CID()}:${SECRET()}`).toString("base64");

// ── App token (products + locations) ────────────────────────────────────────
let appTok: { token: string; exp: number } | null = null;
async function getClientToken(): Promise<string> {
  if (appTok && appTok.exp > Date.now() + 30_000) return appTok.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "product.compact" }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Kroger client token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  appTok = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

// ── User token (cart) — refresh token rotates, so persist it in app_settings ──
export async function exchangeAuthCode(code: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: KROGER_REDIRECT }),
  });
  if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}` };
  const j = (await res.json()) as { refresh_token?: string };
  if (!j.refresh_token) return { ok: false, error: "No refresh token returned." };
  await setSetting("kroger_refresh_token", j.refresh_token);
  return { ok: true };
}

export async function cartAuthorized(): Promise<boolean> {
  return !!(await getSetting("kroger_refresh_token"));
}

async function getUserToken(): Promise<string> {
  const refresh = await getSetting("kroger_refresh_token");
  if (!refresh) throw new Error("Fry's cart isn't authorized yet — run the one-time connect.");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Kroger user token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
  const j = (await res.json()) as { access_token: string; refresh_token?: string };
  if (j.refresh_token && j.refresh_token !== refresh) await setSetting("kroger_refresh_token", j.refresh_token); // rotation
  return j.access_token;
}

// ── Store + product lookup ──────────────────────────────────────────────────
/** Find (and cache) her Fry's store id near a zip. */
export async function getLocationId(zip = "85142"): Promise<string | null> {
  const cached = await getSetting("kroger_location_id");
  if (cached) return cached;
  const tok = await getClientToken();
  const url = `${BASE}/locations?filter.zipCode.near=${zip}&filter.limit=15`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Kroger locations ${res.status}`);
  const j = (await res.json()) as { data?: { locationId: string; chain?: string; name?: string }[] };
  const stores = j.data ?? [];
  const frys = stores.find((s) => /fry/i.test(s.chain ?? "") || /fry/i.test(s.name ?? "")) ?? stores[0];
  if (!frys) return null;
  await setSetting("kroger_location_id", frys.locationId);
  return frys.locationId;
}

/** Best-match UPC for a grocery term at her store (or null if nothing matched). */
// Colloquial → catalog name (Fry's lists regular Coke as "Coca-Cola", so the bare
// word "coke" only matches the Diet product). Keep this list small + obvious.
const TERM_ALIASES: Record<string, string> = { coke: "coca-cola", cokes: "coca-cola", pop: "soda" };

export async function findUpc(term: string, locationId: string): Promise<{ upc: string; name: string } | null> {
  const tok = await getClientToken();
  const searchTerm = TERM_ALIASES[term.toLowerCase().trim()] ?? term;
  const url = `${BASE}/products?filter.term=${encodeURIComponent(searchTerm)}&filter.locationId=${locationId}&filter.limit=5`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` }, cache: "no-store" });
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { upc: string; description?: string }[] };
  const items = j.data ?? [];
  if (!items.length) return null;
  // Kroger's first result isn't always the right item ("bananas" → a mango,
  // "coke" → Diet Coke). Score by word-match, and DEMOTE diet/zero/light-type
  // variants she didn't ask for so the plain version wins.
  const t = searchTerm.toLowerCase();
  const qWords = t.split(/[\s-]+/).filter((w) => w.length > 2);
  const UNWANTED = ["diet", "zero sugar", "zero", "sugar free", "sugar-free", "lite", "light", "decaf", "fat free", "fat-free", "low fat"];
  const score = (p: { description?: string }) => {
    const d = (p.description ?? "").toLowerCase();
    let s = qWords.length && qWords.every((w) => d.includes(w)) ? 100 : qWords.some((w) => d.includes(w)) ? 40 : 0;
    for (const u of UNWANTED) if (d.includes(u) && !t.includes(u)) s -= 30;
    return s;
  };
  const best = [...items].sort((a, b) => score(b) - score(a))[0];
  return best ? { upc: best.upc, name: best.description ?? term } : null;
}

/** Add resolved UPCs to her Fry's cart (requires cart authorization). */
async function addUpcsToCart(items: { upc: string; quantity: number }[]): Promise<void> {
  const tok = await getUserToken();
  const res = await fetch(`${BASE}/cart/add`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
  if (!res.ok && res.status !== 204) throw new Error(`Kroger cart ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
}

/** Orchestrate: take grocery item names → resolve each → load her Fry's cart. */
export async function sendToFrysCart(itemNames: string[]): Promise<{
  ok: boolean; added: string[]; notFound: string[]; error?: string;
}> {
  if (!krogerEnabled()) return { ok: false, added: [], notFound: [], error: "Fry's isn't connected." };
  if (!(await cartAuthorized())) return { ok: false, added: [], notFound: [], error: "needs_auth" };
  const locationId = await getLocationId();
  if (!locationId) return { ok: false, added: [], notFound: [], error: "Couldn't find your Fry's store." };

  const resolved: { upc: string; quantity: number }[] = [];
  const added: string[] = [];
  const notFound: string[] = [];
  for (const name of itemNames.slice(0, 50)) {
    const hit = await findUpc(name, locationId).catch(() => null);
    if (hit) { resolved.push({ upc: hit.upc, quantity: 1 }); added.push(name); }
    else notFound.push(name);
  }
  if (!resolved.length) return { ok: false, added: [], notFound, error: "Nothing matched at Fry's." };
  await addUpcsToCart(resolved);
  return { ok: true, added, notFound };
}
