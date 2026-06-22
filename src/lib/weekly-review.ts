import { desc, eq, isNull } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import {
  db,
  weeklyReviews as weeklyTable,
  roleAttentionEvents as attentionTable,
  activityLog as activityTable,
  decisions as decisionsTable,
  crossroadDiscussions as discussionsTable,
  insights as insightsTable,
  memories as memoriesTable,
  tasks as tasksTable,
  checkins as checkinsTable,
  roles as rolesTable,
  projects as projectsTable,
  workingAgreements as agreementsTable,
  type WeeklyReview,
} from "@/db";
import { todayStr, formatDate } from "./dates";

const MODEL = process.env.COS_MODEL_DEEP || "claude-sonnet-4-6";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type Snapshot = {
  attentionByRole: Record<string, { sessions: number; minutes: number }>;
  checkins: { count: number; avgEnergy: number | null; avgOverwhelm: number | null };
  openCrossroads: { title: string; leaning: string | null; revisitCount: number }[];
  activeProjects: number;
  tasksCompleted: number;
  workouts: number;
};

function inWindow(d: Date | null | undefined, start: Date, end: Date): boolean {
  if (!d) return false;
  const t = new Date(d).getTime();
  return t >= start.getTime() && t < end.getTime();
}

/** Structured metrics for one week — stored so next week can diff against it. */
async function computeSnapshot(start: Date, end: Date): Promise<Snapshot> {
  const roles = await db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));

  const attn = await db.select().from(attentionTable);
  const attentionByRole: Record<string, { sessions: number; minutes: number }> = {};
  let workouts = 0;
  for (const e of attn) {
    if (!inWindow(e.occurredAt, start, end)) continue;
    const name = roleName.get(e.roleId) ?? "Unassigned";
    const slot = (attentionByRole[name] ??= { sessions: 0, minutes: 0 });
    slot.sessions++;
    slot.minutes += e.durationMinutes ?? 0;
    if (name === "Health" && e.attentionType === "focused_work" && /workout|gym/i.test(e.notes ?? "")) workouts++;
  }

  const checkins = await db.select().from(checkinsTable);
  const wk = checkins.filter((c) => inWindow(new Date(`${c.checkinDate}T12:00:00`), start, end));
  const energies = wk.map((c) => c.energyLevel).filter((n): n is number => n != null);
  const overwhelms = wk.map((c) => c.overwhelmLevel).filter((n): n is number => n != null);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

  const decisions = await db.select().from(decisionsTable);
  const openCrossroads = decisions
    .filter((d) => ["active", "open", "reopened", "revisiting"].includes(d.status))
    .map((d) => ({ title: d.title, leaning: d.currentLeaning ?? null, revisitCount: d.revisitCount }));

  const activeProjects = (await db.select().from(projectsTable)).filter((p) => p.status === "active").length;

  const allTasks = await db.select().from(tasksTable);
  const tasksCompleted = allTasks.filter((t) => inWindow(t.completedAt, start, end)).length;

  return {
    attentionByRole,
    checkins: { count: wk.length, avgEnergy: avg(energies), avgOverwhelm: avg(overwhelms) },
    openCrossroads,
    activeProjects,
    tasksCompleted,
    workouts,
  };
}

/** Build the full evidence packet (change-streams + deltas + forward look). */
async function gatherWeek(): Promise<string> {
  const end = new Date();
  const start = new Date(end.getTime() - WEEK_MS);
  const prevStart = new Date(start.getTime() - WEEK_MS);
  const lines: string[] = [];

  const roles = await db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));

  // ---- Prior review: follow-through + last snapshot for diff ----
  const [prior] = await db.select().from(weeklyTable).orderBy(desc(weeklyTable.weekOf)).limit(1);
  if (prior) {
    lines.push(`LAST WEEK'S REVIEW (week of ${formatDate(prior.weekOf)}) — CLOSE THE LOOP on these:`);
    const pri = (prior.priorities as { item: string; why?: string }[] | null) ?? [];
    if (pri.length) pri.forEach((p) => lines.push(`  - You said to focus on: ${p.item}`));
    if (prior.biggestQuestion) lines.push(`  - The open question you posed: ${prior.biggestQuestion}`);
    lines.push("(Check what actually happened to each — done, ignored, or slipped? That gap is the most honest evidence for 'where am I fooling myself'.)");
    lines.push("");
  } else {
    lines.push("This is the FIRST weekly review — there's no prior week to compare against, so set a baseline and say so plainly rather than inventing comparisons.");
    lines.push("");
  }

  // ---- This week vs last week: the deltas ----
  const thisSnap = await computeSnapshot(start, end);
  const lastSnap = (prior?.snapshot as Snapshot | null) ?? null;

  lines.push("ATTENTION THIS WEEK (sessions logged, by role, by when they happened):");
  const allRoleNames = new Set([...Object.keys(thisSnap.attentionByRole), ...Object.keys(lastSnap?.attentionByRole ?? {})]);
  for (const name of allRoleNames) {
    const now = thisSnap.attentionByRole[name]?.sessions ?? 0;
    const was = lastSnap?.attentionByRole?.[name]?.sessions;
    const delta = was == null ? "" : ` (last week: ${was})`;
    lines.push(`  - ${name}: ${now}${delta}`);
  }
  lines.push("");

  if (thisSnap.checkins.count || lastSnap?.checkins.count) {
    const e = thisSnap.checkins.avgEnergy, o = thisSnap.checkins.avgOverwhelm;
    const le = lastSnap?.checkins.avgEnergy, lo = lastSnap?.checkins.avgOverwhelm;
    lines.push(`CHECK-INS: ${thisSnap.checkins.count} this week — avg energy ${e ?? "?"}${le != null ? ` (was ${le})` : ""}, avg overwhelm ${o ?? "?"}${lo != null ? ` (was ${lo})` : ""}.`);
    lines.push("");
  }

  lines.push(`HABITS: ${thisSnap.workouts} workouts this week${lastSnap ? ` (last week: ${lastSnap.workouts})` : ""}. Tasks closed off lists: ${thisSnap.tasksCompleted}${lastSnap ? ` (last week: ${lastSnap.tasksCompleted})` : ""} (closed ≠ done — don't treat as accomplishments).`);
  lines.push("");

  // ---- Change streams (what actually moved) ----
  const acts = (await db.select().from(activityTable).orderBy(desc(activityTable.createdAt)).limit(200))
    .filter((a) => inWindow(a.createdAt, start, end) && !a.undoneAt);
  if (acts.length) {
    lines.push("THINGS THAT HAPPENED / WERE LOGGED THIS WEEK:");
    acts.slice(0, 30).forEach((a) => lines.push(`  - ${a.summary}`));
    lines.push("");
  }

  const discs = (await db.select().from(discussionsTable)).filter((d) => inWindow(d.createdAt, start, end));
  if (discs.length) {
    const dec = new Map((await db.select().from(decisionsTable)).map((d) => [d.id, d.title]));
    lines.push("DECISIONS (crossroads) TOUCHED THIS WEEK:");
    discs.forEach((d) => lines.push(`  - "${dec.get(d.decisionId) ?? "?"}": ${d.leaning ?? d.note ?? "discussed"}`));
    lines.push("");
  }

  const obs = (await db.select().from(insightsTable)).filter((o) => inWindow(o.createdAt, start, end));
  if (obs.length) {
    lines.push("NEW OBSERVATIONS THIS WEEK:");
    obs.forEach((o) => lines.push(`  - ${o.summary}`));
    lines.push("");
  }

  const mems = (await db.select().from(memoriesTable)).filter((m) => inWindow(m.createdAt, start, end) && m.status === "active");
  if (mems.length) {
    lines.push("NEW LONG-TERM MEMORY CAPTURED THIS WEEK:");
    mems.forEach((m) => lines.push(`  - [${m.type}] ${m.content}`));
    lines.push("");
  }

  const completed = (await db.select().from(tasksTable)).filter((t) => inWindow(t.completedAt, start, end));
  if (completed.length) {
    lines.push(`TASKS CLOSED/REMOVED FROM LISTS THIS WEEK (${completed.length}) — IMPORTANT: a closed task does NOT mean the work was done; she may have just cleared the list. Do NOT report these as accomplishments or say anything is "done" based on them:`);
    completed.slice(0, 20).forEach((t) => lines.push(`  - ${t.title}${t.roleId ? ` (${roleName.get(t.roleId) ?? "?"})` : ""}`));
    lines.push("");
  }

  // ---- Stated priorities (for the 'fooling myself' divergence check) ----
  const highRoles = roles.filter((r) => r.importanceLevel === "high").map((r) => r.name);
  if (highRoles.length) lines.push(`STATED HIGH-IMPORTANCE ROLES (what she says matters most): ${highRoles.join(", ")}.`);
  const agreements = (await db.select().from(agreementsTable)).filter((a) => a.status === "active");
  if (agreements.length) {
    lines.push("STANDING PRIORITIES / AGREEMENTS (compare against where attention actually went):");
    agreements.slice(0, 8).forEach((a) => lines.push(`  - ${a.text}`));
  }
  const goals = mems.filter((m) => m.type === "identity" || m.type === "temporary_context");
  // identity/temp goals already listed above; the model can use them.
  lines.push("");

  // ---- Forward look: next week's calendar (genuine prep for section 3) ----
  try {
    const { calendarEnabled, listEventsBetween } = await import("./integrations/google-calendar");
    if (calendarEnabled()) {
      const nextEnd = new Date(end.getTime() + WEEK_MS);
      const upcoming = await listEventsBetween(end, nextEnd);
      lines.push(`NEXT WEEK'S CALENDAR (${upcoming.length} events — use this to make section 3 real prep, not generic):`);
      upcoming.slice(0, 30).forEach((e) => lines.push(`  - ${formatDate(e.start)}${e.allDay ? " (all day)" : ""} ${e.title}${e.isPrimary ? "" : ` [${e.calendar}]`}`));
      lines.push("");
    }
  } catch {
    /* calendar optional */
  }

  return lines.join("\n");
}

const WEEKLY_SYSTEM_TAIL = `You are writing Selena's WEEKLY chief-of-staff review — delivered Sunday evening. This is NOT the daily briefing and NOT a dashboard. You are a sharp chief of staff who has been paying attention all week, sitting down with her to say: "Here's what actually happened, here's what matters, here's where you're not seeing something clearly, and here's what I'd focus on."

It is COMPARATIVE: focus on what CHANGED versus a week ago — movement, not a snapshot. Lead with one short throughline sentence that names the week. Then these five parts (use them as a spine, write in flowing prose with light headers, not a report):

1. What changed this week — what's genuinely different than 7 days ago. Lead with the OPERATIONAL movement: projects, decisions, deadlines, systems, open loops, follow-ups, commitments. Habits/relationships/health can appear, but they're not the focus of this section. Movement only; skip what just sits unchanged.
2. Where you're fooling yourself — honest, EVIDENCE-BASED gap between actions and stated priorities. This is OPERATIONAL self-deception FIRST: a decision you keep deferring, a project you say matters that got no movement, overcommitment/capacity you're ignoring, a recommendation from last week that slipped. A personal/relational divergence belongs here only if it's genuinely the most important one this week — at most one, and don't reach for it. Not motivational, not judgmental, not a lecture — the honest read with the evidence.
3. What deserves attention next week — at most THREE items, prioritized, each with a reason it matters MORE than the alternatives. Operational prep: weave in next week's actual calendar load, deadlines, and any decision that's overdue to be made.
4. What got better — wins, progress, resolved things, decisions made, things shipped. Real and specific. Don't only notice problems.
5. The biggest unanswered question — ONE strategic question worth her thinking time next week (usually operational/strategic, not therapeutic).

If there's a prior week, CLOSE THE LOOP on what you told her to focus on last week (did it happen?) — that belongs in parts 1/2. If this is the first review, say so and set a baseline instead of inventing comparisons.

You are her CHIEF OF STAFF reviewing operations — not a coach evaluating her life. Lead with what needs managing. Pattern recognition and accountability are supporting; relationship/health/emotional threads are occasional and brief, never the dominant lens. If a week was mostly operational, the review should read mostly operational.

Hard rules: no dashboard feel, no metrics dump, no role-by-role report card, no manufactured urgency, no generic productivity advice, no therapizing. Judgment over reporting, synthesis over summary, changes over snapshots. Warm, direct, a little funny when it's earned — her chief of staff, not software.

CRITICAL — do NOT infer accomplishment from data: a closed or deleted task is NOT proof the real thing got done (she often clears tasks without doing the work). NEVER say a project/area is "done" or "handled" from task counts alone. State closures factually at most ("N tasks were closed under X"), and only claim something actually happened if there's direct evidence — a logged note, her saying so, or a completed item with real detail. When in doubt, describe what the data shows, not what you assume it means. Better to under-claim than to tell her she did something she didn't.

After the prose, output exactly one line:
<<DATA>>{"throughline":"...","priorities":[{"item":"...","why":"..."},...],"biggestQuestion":"..."}<<END>>
with the 3 (or fewer) priorities from part 3 and the question from part 5. This line is for the system; she never sees it.`;

export async function generateWeeklyReview(): Promise<WeeklyReview> {
  const weekOf = todayStr();
  const evidence = await gatherWeek();
  const end = new Date();
  const start = new Date(end.getTime() - WEEK_MS);
  const snapshot = await computeSnapshot(start, end);

  let narrative = "";
  let throughline: string | null = null;
  let biggestQuestion: string | null = null;
  let priorities: { item: string; why?: string }[] = [];

  try {
    const { SCOUT_VOICE } = await import("./ai");
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1800,
      thinking: { type: "disabled" },
      system: `${SCOUT_VOICE}\n\n${WEEKLY_SYSTEM_TAIL}`,
      messages: [{ role: "user", content: `Today is ${formatDate(weekOf)}. Here's the week's evidence:\n\n${evidence}\n\nWrite the weekly review.` }],
    });
    const raw = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    const m = raw.match(/<<DATA>>([\s\S]*?)<<END>>/);
    if (m) {
      try {
        const data = JSON.parse(m[1].trim());
        throughline = data.throughline ?? null;
        biggestQuestion = data.biggestQuestion ?? null;
        priorities = Array.isArray(data.priorities) ? data.priorities : [];
      } catch {
        /* keep narrative even if the data line is malformed */
      }
    }
    narrative = raw.replace(/<<DATA>>[\s\S]*?<<END>>/, "").trim();
  } catch (err) {
    console.error("weekly review generation failed", err);
    narrative = "Couldn't generate this week's review (AI unavailable). The underlying data is intact — try regenerating.";
  }

  // Upsert by week.
  const [existing] = await db.select().from(weeklyTable).where(eq(weeklyTable.weekOf, weekOf)).limit(1);
  if (existing) {
    const [updated] = await db
      .update(weeklyTable)
      .set({ narrative, throughline, biggestQuestion, priorities, snapshot, openedAt: null })
      .where(eq(weeklyTable.id, existing.id))
      .returning();
    return updated;
  }
  const [row] = await db
    .insert(weeklyTable)
    .values({ weekOf, narrative, throughline, biggestQuestion, priorities, snapshot })
    .returning();
  return row;
}

export async function getLatestWeeklyReview(): Promise<WeeklyReview | null> {
  const [r] = await db.select().from(weeklyTable).orderBy(desc(weeklyTable.weekOf), desc(weeklyTable.createdAt)).limit(1);
  return r ?? null;
}

/** This week's review if it exists, else generate it (used by the page + cron). */
export async function getOrGenerateWeeklyReview(): Promise<WeeklyReview> {
  const weekOf = todayStr();
  const [existing] = await db.select().from(weeklyTable).where(eq(weeklyTable.weekOf, weekOf)).limit(1);
  if (existing) return existing;
  return generateWeeklyReview();
}

/** Force a FRESH review from current Compass state (used by chat asks, so it can
 *  never replay a stale cached narrative after she's corrected things). */
export async function regenerateWeeklyReview(): Promise<WeeklyReview> {
  await db.delete(weeklyTable).where(eq(weeklyTable.weekOf, todayStr()));
  return generateWeeklyReview();
}

export async function markWeeklyReviewOpened(id: string): Promise<void> {
  await db.update(weeklyTable).set({ openedAt: new Date() }).where(eq(weeklyTable.id, id));
}
