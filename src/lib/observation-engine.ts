import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import {
  db,
  insights as insightsTable,
  integrations as integrationsTable,
  tasks as tasksTable,
  decisions as decisionsTable,
  checkins as checkinsTable,
  roles as rolesTable,
} from "@/db";
import { scoreRoles } from "./briefing";
import { aiEnabled } from "./ai";
import { formatDate } from "./dates";

/**
 * Observation Engine — automatic, cross-source pattern detection.
 *
 * Quality over quantity: it runs only at meaningful moments (throttled), and
 * records an observation ONLY when a genuine pattern connects ≥2 sources and
 * isn't a duplicate of an existing one. Zero new observations is the expected,
 * correct outcome most days.
 */

const ENGINE_MARKER = "ObservationEngine"; // an integrations row tracks last-run time
const THROTTLE_HOURS = 12;
const MAX_NEW_PER_RUN = 2;
const MODEL = process.env.COS_AI_MODEL || "claude-opus-4-8";

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Has the engine run within the throttle window? */
async function isThrottled(): Promise<boolean> {
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.provider, ENGINE_MARKER)).limit(1);
  if (!row?.lastSyncAt) return false;
  return Date.now() - new Date(row.lastSyncAt).getTime() < THROTTLE_HOURS * 60 * 60 * 1000;
}

async function markRun() {
  const [row] = await db.select().from(integrationsTable).where(eq(integrationsTable.provider, ENGINE_MARKER)).limit(1);
  if (row) {
    await db.update(integrationsTable).set({ lastSyncAt: new Date(), status: "connected", updatedAt: new Date() }).where(eq(integrationsTable.id, row.id));
  } else {
    await db.insert(integrationsTable).values({ provider: ENGINE_MARKER, status: "connected", lastSyncAt: new Date() });
  }
}

/** Compact cross-source snapshot for the detector. */
async function buildSnapshot(): Promise<string> {
  const lines: string[] = [];

  const scored = await scoreRoles();
  lines.push("ROLES (name | importance | score | open_tasks | days_since_attention | recent_attention):");
  for (const s of scored) {
    lines.push(`- ${s.role.name} | ${s.role.importanceLevel} | ${s.score} | ${s.openTaskCount} | ${s.daysSinceAttention ?? "never"} | credit ${s.attentionCredit}`);
  }

  // Overdue / stale open tasks (with role).
  const open = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const roleName = new Map(scored.map((s) => [s.role.id, s.role.name]));
  const now = Date.now();
  const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now);
  if (overdue.length) {
    lines.push("");
    lines.push(`OVERDUE TASKS (${overdue.length}):`);
    overdue.slice(0, 10).forEach((t) => lines.push(`- ${t.title} (${t.roleId ? roleName.get(t.roleId) ?? "?" : "no role"}, due ${formatDate(t.dueDate)})`));
  }

  // Latest check-in.
  const [checkin] = await db.select().from(checkinsTable).orderBy(desc(checkinsTable.checkinDate), desc(checkinsTable.createdAt)).limit(1);
  if (checkin) {
    lines.push("");
    lines.push(`LATEST CHECK-IN (${formatDate(checkin.checkinDate)}): energy ${checkin.energyLevel ?? "?"}, overwhelm ${checkin.overwhelmLevel ?? "?"}${checkin.notes ? ` — ${checkin.notes}` : ""}`);
  }

  // Open crossroads.
  const crossroads = await db.select().from(decisionsTable);
  const openCross = crossroads.filter((d) => d.status !== "archived" && d.status !== "decided");
  if (openCross.length) {
    lines.push("");
    lines.push("OPEN CROSSROADS:");
    openCross.slice(0, 8).forEach((d) => lines.push(`- "${d.title}" leaning=${d.currentLeaning ?? "?"} revisits=${d.revisitCount}`));
  }

  // Email: unread in the last week, grouped by life-area label.
  try {
    const { gmailConfigured, listEmails } = await import("./integrations/gmail");
    if (gmailConfigured()) {
      const unread = await listEmails("is:unread newer_than:7d", 25);
      const byLabel = new Map<string, number>();
      for (const e of unread) for (const l of e.labels.length ? e.labels : ["(unlabeled)"]) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
      if (unread.length) {
        lines.push("");
        lines.push(`UNREAD EMAIL (last 7d, by label): ${[...byLabel.entries()].map(([l, n]) => `${l}:${n}`).join(", ")}`);
      }
    }
  } catch {
    /* email optional */
  }

  // Existing open observations (anti-duplication context).
  const existing = await db.select().from(insightsTable).where(eq(insightsTable.status, "open"));
  if (existing.length) {
    lines.push("");
    lines.push("EXISTING OPEN OBSERVATIONS (do NOT repeat or rephrase these):");
    existing.forEach((o) => lines.push(`- ${o.summary}`));
  }

  return lines.join("\n");
}

const DETECTOR_SYSTEM = `You are Scout's pattern-detection pass. You look across Selena's whole life-snapshot and surface only GENUINELY meaningful patterns — the kind a sharp Chief of Staff would mention, not a dashboard.

STRICT rules (quality over quantity):
1. Only include an observation if it connects AT LEAST TWO different sources (e.g. attention + tasks, email + a neglected role, check-in + behavior, a crossroad that keeps recurring + lack of progress).
2. Never restate a single metric. "Health has 7 open tasks" is NOT an observation. "Health tasks are piling up while it's the role you rated lowest and haven't touched in two weeks" might be.
3. Do NOT duplicate or rephrase anything under EXISTING OPEN OBSERVATIONS.
4. Non-obvious and worth her attention. If nothing clears this bar, return an empty array — zero is the right, expected answer most days.
5. At most ${MAX_NEW_PER_RUN}. If you have several, keep only the strongest.

Return ONLY JSON: an array (possibly empty) of objects:
[{"summary": "one tight sentence in plain language", "detail": "1-2 sentences citing the specific sources", "role": "role name or null", "severity": "info|notice|concern"}]`;

type Candidate = { summary: string; detail?: string; role?: string | null; severity?: string };

/** Run a detection pass. Returns the observations actually recorded. */
export async function runObservationPass(opts: { force?: boolean } = {}): Promise<{ created: number; skipped: number }> {
  if (!aiEnabled()) return { created: 0, skipped: 0 };
  if (!opts.force && (await isThrottled())) return { created: 0, skipped: 0 };
  await markRun(); // mark before the call so concurrent triggers don't double-run

  const snapshot = await buildSnapshot();
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    thinking: { type: "disabled" },
    system: DETECTOR_SYSTEM,
    messages: [{ role: "user", content: `Snapshot:\n\n${snapshot}` }],
  });
  const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();

  let candidates: Candidate[] = [];
  try {
    const match = text.match(/\[[\s\S]*\]/);
    candidates = match ? JSON.parse(match[0]) : [];
  } catch {
    candidates = [];
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return { created: 0, skipped: 0 };

  // Dedup against existing open observations (fuzzy).
  const existing = await db.select().from(insightsTable).where(eq(insightsTable.status, "open"));
  const existingNorms = existing.map((o) => norm(o.summary));
  const roles = await db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));

  let created = 0;
  let skipped = 0;
  for (const c of candidates.slice(0, MAX_NEW_PER_RUN)) {
    if (!c?.summary) continue;
    const cn = norm(c.summary);
    const dup = existingNorms.some((e) => {
      if (e === cn || e.includes(cn) || cn.includes(e)) return true;
      const ew = new Set(e.split(" "));
      const cw = cn.split(" ").filter(Boolean);
      const overlap = cw.filter((w) => ew.has(w)).length / Math.max(cw.length, 1);
      return overlap >= 0.6;
    });
    if (dup) {
      skipped++;
      continue;
    }
    const role = c.role ? roles.find((r) => r.name.toLowerCase() === c.role!.toLowerCase()) : null;
    await db.insert(insightsTable).values({
      kind: "pattern",
      roleId: role?.id ?? null,
      summary: c.summary.slice(0, 300),
      detail: c.detail ?? null,
      severity: c.severity ?? "info",
      source: "engine",
      status: "open",
    });
    existingNorms.push(cn);
    created++;
  }
  return { created, skipped };
}
