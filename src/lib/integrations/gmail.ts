/**
 * Gmail integration.
 *
 * Reuses the same Google OAuth credentials as Calendar (GOOGLE_CLIENT_ID/SECRET
 * + GOOGLE_REFRESH_TOKEN). The refresh token must include Gmail scopes — re-run
 * `npm run google:auth` after enabling the Gmail API to grant them.
 *
 * Capabilities: read mail across all folders (search), create drafts, and send.
 * Sending is gated in Scout's prompt — it always confirms before send_email.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function gmailConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN
  );
}

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN!,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Google token exchange ${res.status}: ${t.slice(0, 200)}`);
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

function headerVal(headers: { name: string; value: string }[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

export type EmailSummary = { id: string; from: string; subject: string; date: string; snippet: string };

/**
 * Search/list emails. `query` uses Gmail search syntax (e.g. "from:mom",
 * "subject:invoice", "newer_than:7d", "is:unread", "in:anywhere" for all folders
 * incl. spam/trash, "label:PTO"). Empty query = recent inbox.
 */
export async function listEmails(query = "", max = 15): Promise<EmailSummary[]> {
  const token = await getAccessToken();
  const url = new URL(`${API}/messages`);
  url.searchParams.set("maxResults", String(Math.min(max, 25)));
  if (query) url.searchParams.set("q", query);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail list ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = (await res.json()) as { messages?: { id: string }[] };
  const ids = (data.messages ?? []).map((m) => m.id);

  const summaries = await Promise.all(
    ids.map(async (id) => {
      const mUrl = new URL(`${API}/messages/${id}`);
      mUrl.searchParams.set("format", "metadata");
      for (const h of ["From", "Subject", "Date"]) mUrl.searchParams.append("metadataHeaders", h);
      const mRes = await fetch(mUrl, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
      const msg = (await mRes.json()) as {
        snippet?: string;
        payload?: { headers?: { name: string; value: string }[] };
      };
      return {
        id,
        from: headerVal(msg.payload?.headers, "From"),
        subject: headerVal(msg.payload?.headers, "Subject") || "(no subject)",
        date: headerVal(msg.payload?.headers, "Date"),
        snippet: msg.snippet ?? "",
      };
    })
  );
  return summaries;
}

function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };

function extractText(part: Part | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return decodeBody(part.body.data);
  if (part.parts) {
    for (const p of part.parts) {
      const t = extractText(p);
      if (t) return t;
    }
  }
  if (part.mimeType === "text/html" && part.body?.data) {
    return decodeBody(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  }
  return "";
}

export async function readEmail(id: string): Promise<{ from: string; subject: string; date: string; body: string }> {
  const token = await getAccessToken();
  const res = await fetch(`${API}/messages/${id}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail read ${res.status}: ${t.slice(0, 200)}`);
  }
  const msg = (await res.json()) as {
    payload?: Part & { headers?: { name: string; value: string }[] };
  };
  const body = extractText(msg.payload).slice(0, 4000);
  return {
    from: headerVal(msg.payload?.headers, "From"),
    subject: headerVal(msg.payload?.headers, "Subject") || "(no subject)",
    date: headerVal(msg.payload?.headers, "Date"),
    body,
  };
}

function toRawMessage(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "MIME-Version: 1.0",
    "",
    body,
  ].join("\r\n");
  return Buffer.from(mime).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createDraft(input: { to: string; subject: string; body: string }): Promise<string> {
  const token = await getAccessToken();
  const raw = toRawMessage(input.to, input.subject, input.body);
  const res = await fetch(`${API}/drafts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message: { raw } }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail draft ${res.status}: ${t.slice(0, 200)}`);
  }
  return ((await res.json()) as { id: string }).id;
}

export async function sendEmail(input: { to: string; subject: string; body: string }): Promise<string> {
  const token = await getAccessToken();
  const raw = toRawMessage(input.to, input.subject, input.body);
  const res = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Gmail send ${res.status}: ${t.slice(0, 200)}`);
  }
  return ((await res.json()) as { id: string }).id;
}
