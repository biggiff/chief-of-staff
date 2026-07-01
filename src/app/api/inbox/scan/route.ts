import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { notifyOwner, ownerReachable } from "@/lib/integrations/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Proactive inbox watch (cron). Scans recent real inbox mail for things that
 * actually need HER — dates, deadlines, RSVPs, bills, kids/school items, order
 * requests — and texts a short digest so they don't get buried (the QC invoice /
 * birthday-invite pattern). One cheap model call per scan; deduped by message id
 * so nothing is surfaced twice. CRON_SECRET-authed.
 */
async function run(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "No AI key." });

  const { gmailConfigured, listEmails, listThreadIds } = await import("@/lib/integrations/gmail");
  if (!gmailConfigured()) return NextResponse.json({ ok: false, error: "Gmail not connected." });
  if (!(await ownerReachable())) return NextResponse.json({ ok: false, error: "No messaging channel." });

  const { getSetting, setSetting } = await import("@/lib/operator");

  // Recent real inbox mail only — skip the promo/marketing noise she already filters.
  const emails = await listEmails("newer_than:2d in:inbox -category:promotions", 25).catch(() => []);
  if (!emails.length) return NextResponse.json({ ok: true, scanned: 0 });

  // If she's already replied, that thread shows up in Sent — treat it as handled
  // and don't surface it (the "acted upon" check she asked for).
  const repliedThreads = new Set(await listThreadIds("newer_than:14d in:sent", 80).catch(() => []));

  const seen = new Set(((await getSetting("inbox_seen")) || "").split(",").filter(Boolean));
  const fresh = emails.filter((e) => !seen.has(e.id) && !repliedThreads.has(e.threadId));
  if (!fresh.length) return NextResponse.json({ ok: true, scanned: emails.length, fresh: 0 });

  // ONE cheap call: for each genuinely-actionable email, SUGGEST a concrete task.
  const client = new Anthropic();
  const list = fresh.map((e, i) => `[${i}] from: ${e.from} | subject: ${e.subject} | ${(e.snippet || "").slice(0, 220)}`).join("\n");
  let items: { i: number; task: string; type?: string; from?: string }[] = [];
  try {
    const resp = await client.messages.create({
      model: process.env.COS_MODEL_LIGHT || "claude-haiku-4-5",
      max_tokens: 1024,
      thinking: { type: "disabled" },
      system:
        "You triage a busy mom + small-business owner's email inbox and SUGGEST to-dos. From the emails below, pick ONLY the ones that need HER action or carry a real date/deadline/commitment: appointments, RSVPs, bills due, school/kids deadlines, document/info requests, order requests, anything time-sensitive she'd hate to miss. IGNORE marketing, newsletters, receipts, shipping/order confirmations, security/login codes, pure FYI. For each, write a CONCRETE task as an imperative (verb + specific object + any date): e.g. \"Send Tanya the signed lease + COI\", \"Pay QC facility invoice #2627-138 before 7/23\", \"RSVP to David's party by Fri\". Return ONLY JSON: {\"items\":[{\"i\":<index>,\"task\":\"<the suggested to-do>\",\"type\":\"task\"|\"calendar\",\"from\":\"<sender's short name>\"}]}. type=calendar only if it's an event/appointment with a date. If nothing genuinely needs her, return {\"items\":[]}.",
      messages: [{ role: "user", content: list }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    if (Array.isArray(parsed.items)) items = parsed.items;
  } catch (err) {
    console.error("inbox scan extract failed", err);
  }

  // Mark every fresh email as seen (evaluated once), cap the memory.
  await setSetting("inbox_seen", [...seen, ...fresh.map((e) => e.id)].slice(-300).join(","));

  if (!items.length) return NextResponse.json({ ok: true, scanned: emails.length, surfaced: 0 });

  const shown = items.slice(0, 6);
  const lines = ["📥 From your inbox — suggested to-dos:"];
  shown.forEach((it, n) => lines.push(`${n + 1}. ${it.task}${it.from ? `  — ${it.from}` : ""}${it.type === "calendar" ? " 📅" : ""}`));
  lines.push("", 'Reply "add all", or e.g. "add 1, 3" and I\'ll create them. Ignore to skip.');
  const digest = lines.join("\n");
  const res = await notifyOwner(digest);

  // Store the digest in the Telegram conversation so when she replies "add 1,3"
  // Scout has the numbered suggestions in context to create them precisely.
  try {
    const { db, conversations, messages } = await import("@/db");
    const { eq } = await import("drizzle-orm");
    const [conv] = await db.select().from(conversations).where(eq(conversations.title, "💬 Telegram")).limit(1);
    if (conv) await db.insert(messages).values({ conversationId: conv.id, role: "chief_of_staff", content: digest });
  } catch (err) {
    console.error("inbox digest store failed", err);
  }

  return NextResponse.json({ ok: res.ok, scanned: emails.length, surfaced: shown.length });
}

export const GET = run;
export const POST = run;
