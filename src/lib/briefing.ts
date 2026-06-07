import { and, eq, isNull, desc } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  briefings as briefingsTable,
  checkins as checkinsTable,
  checkinRoleScores as checkinRoleScoresTable,
  type Role,
  type Briefing,
} from "@/db";
import { daysSince, todayStr } from "./dates";

/**
 * Rule-based attention scoring.
 *
 * The goal is NOT to surface the longest task list. It is to interpret role
 * *health* and recommend where attention should go — distinguishing urgency
 * from strategic neglect. Every point added to a role's score carries a
 * human-readable reason so the recommendation is fully auditable.
 */

export type ScoreReason = { label: string; points: number };

export type RoleScore = {
  role: Role;
  score: number;
  reasons: ScoreReason[];
  openTaskCount: number;
  overdueHighPriorityCount: number;
  stalledProjectCount: number;
  latestHealthScore: number | null;
  daysSinceAttention: number | null;
  topAvoidedTaskTitle: string | null;
  maxAvoidanceCount: number;
};

const IMPORTANCE_WEIGHT: Record<string, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const STATUS_WEIGHT: Record<string, number> = {
  critical: 10,
  needs_attention: 6,
  maintaining: 2,
  healthy: 0,
  thriving: -2,
};

/** Score every active role and sort most-in-need-of-attention first. */
export async function scoreRoles(): Promise<RoleScore[]> {
  const activeRoles = await db
    .select()
    .from(rolesTable)
    .where(isNull(rolesTable.archivedAt));

  // Latest check-in (for per-role health scores).
  const latestCheckin = await db
    .select()
    .from(checkinsTable)
    .orderBy(desc(checkinsTable.checkinDate), desc(checkinsTable.createdAt))
    .limit(1);

  const roleHealth = new Map<string, number>();
  if (latestCheckin[0]) {
    const scores = await db
      .select()
      .from(checkinRoleScoresTable)
      .where(eq(checkinRoleScoresTable.checkinId, latestCheckin[0].id));
    for (const s of scores) {
      if (s.healthScore != null) roleHealth.set(s.roleId, s.healthScore);
    }
  }

  const results: RoleScore[] = [];

  for (const role of activeRoles) {
    const reasons: ScoreReason[] = [];
    let score = 0;

    const importanceMult = IMPORTANCE_WEIGHT[role.importanceLevel] ?? 2;

    // 1) Current status.
    const statusPts = (STATUS_WEIGHT[role.currentStatus] ?? 0);
    if (statusPts !== 0) {
      score += statusPts;
      reasons.push({
        label: `Status is "${role.currentStatus.replace("_", " ")}"`,
        points: statusPts,
      });
    }

    // 2) Latest check-in health score (1-10, lower = needs more attention).
    const health = roleHealth.get(role.id) ?? null;
    if (health != null) {
      const pts = Math.max(0, 7 - health) * 2; // health<=6 starts adding pressure
      if (pts > 0) {
        score += pts;
        reasons.push({
          label: `Last self-rated health was ${health}/10`,
          points: pts,
        });
      }
    }

    // 3) Open / overdue high-priority tasks.
    const openTasks = await db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.roleId, role.id), eq(tasksTable.status, "open")));

    const now = Date.now();
    let overdueHigh = 0;
    let maxAvoidance = 0;
    let topAvoidedTitle: string | null = null;
    for (const t of openTasks) {
      const overdue = t.dueDate ? new Date(t.dueDate).getTime() < now : false;
      if (t.priority === "high" && overdue) overdueHigh++;
      if (t.avoidanceCount > maxAvoidance) {
        maxAvoidance = t.avoidanceCount;
        topAvoidedTitle = t.title;
      }
    }
    if (overdueHigh > 0) {
      const pts = overdueHigh * 3;
      score += pts;
      reasons.push({
        label: `${overdueHigh} overdue high-priority task${overdueHigh > 1 ? "s" : ""}`,
        points: pts,
      });
    }

    // 4) Avoidance — repeatedly skipped tasks signal a stuck point.
    if (maxAvoidance >= 2) {
      const pts = Math.min(maxAvoidance, 5) * 2;
      score += pts;
      reasons.push({
        label: `Task avoided ${maxAvoidance}× ("${topAvoidedTitle}")`,
        points: pts,
      });
    }

    // 5) Active projects with no recent progress (stalled), weighted by strategy.
    const activeProjects = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.roleId, role.id), eq(projectsTable.status, "active")));

    let stalled = 0;
    for (const p of activeProjects) {
      const since = daysSince(p.lastMeaningfulProgressAt) ?? daysSince(p.createdAt);
      if (since != null && since >= 7) {
        stalled++;
        const stratMult = IMPORTANCE_WEIGHT[p.strategicImportance] ?? 2;
        const pts = stratMult; // strategically important stalls hurt more
        score += pts;
        reasons.push({
          label: `Project "${p.name}" stalled ${since}d (${p.strategicImportance} importance)`,
          points: pts,
        });
      }
    }

    // 6) Role-level neglect — no meaningful attention in a while.
    const attentionDays = daysSince(role.lastMeaningfulAttentionAt);
    if (attentionDays == null) {
      const pts = importanceMult;
      score += pts;
      reasons.push({
        label: "No meaningful attention ever logged",
        points: pts,
      });
    } else if (attentionDays >= 5) {
      const pts = Math.min(Math.floor(attentionDays / 5), 4) * importanceMult;
      score += pts;
      reasons.push({
        label: `${attentionDays} days since meaningful attention`,
        points: pts,
      });
    }

    // 7) Importance acts as a gentle multiplier on the accumulated pressure.
    if (score > 0) {
      const boosted = Math.round(score * (1 + (importanceMult - 1) * 0.15));
      if (boosted !== score) {
        reasons.push({
          label: `${role.importanceLevel} importance role`,
          points: boosted - score,
        });
        score = boosted;
      }
    }

    results.push({
      role,
      score,
      reasons,
      openTaskCount: openTasks.length,
      overdueHighPriorityCount: overdueHigh,
      stalledProjectCount: stalled,
      latestHealthScore: health,
      daysSinceAttention: attentionDays,
      topAvoidedTaskTitle: maxAvoidance >= 2 ? topAvoidedTitle : null,
      maxAvoidanceCount: maxAvoidance,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/** Suggest a concrete, small next action for a role. */
async function suggestNextAction(rs: RoleScore): Promise<string> {
  // Prefer the most-avoided open task, then highest-priority/overdue open task.
  const openTasks = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.roleId, rs.role.id), eq(tasksTable.status, "open")));

  if (openTasks.length === 0) {
    return `No open tasks logged for ${rs.role.name}. Spend 15 minutes deciding the single most valuable next step and capture it.`;
  }

  const priorityRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  openTasks.sort((a, b) => {
    if (b.avoidanceCount !== a.avoidanceCount) return b.avoidanceCount - a.avoidanceCount;
    const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    if (dueA !== dueB) return dueA - dueB;
    return (priorityRank[b.priority] ?? 0) - (priorityRank[a.priority] ?? 0);
  });

  const t = openTasks[0];
  const mins = t.estimatedMinutes ? ` (~${t.estimatedMinutes} min)` : "";
  if (t.avoidanceCount >= 2) {
    return `Do the first 15 minutes of "${t.title}"${mins} — you've skipped it ${t.avoidanceCount}× and the avoidance is the real cost.`;
  }
  return `Spend 15 minutes on "${t.title}"${mins}.`;
}

/** Build and persist today's briefing from current database state. */
export async function generateBriefing(briefingDate = todayStr()): Promise<Briefing> {
  const scored = await scoreRoles();

  if (scored.length === 0) {
    const [b] = await db
      .insert(briefingsTable)
      .values({
        briefingDate,
        summary: "No active roles yet. Add roles to get a real briefing.",
        whyThis: "There is nothing to score.",
        whyNow: "—",
        whyNotOtherRoles: "—",
        next15MinuteAction: "Go to Roles and add your first role.",
        safeToIgnore: "—",
        avoidanceAlerts: "—",
      })
      .returning();
    return b;
  }

  const focus = scored[0];
  const others = scored.slice(1);

  // Why this / why now.
  const whyThis =
    focus.reasons.length > 0
      ? focus.reasons.map((r) => `• ${r.label} (+${r.points})`).join("\n")
      : `• ${focus.role.name} carries the most accumulated pressure right now.`;

  const whyNowBits: string[] = [];
  if (focus.overdueHighPriorityCount > 0)
    whyNowBits.push(`${focus.overdueHighPriorityCount} high-priority item(s) already overdue`);
  if (focus.maxAvoidanceCount >= 2)
    whyNowBits.push(`a task here has been avoided ${focus.maxAvoidanceCount}×`);
  if (focus.daysSinceAttention != null && focus.daysSinceAttention >= 5)
    whyNowBits.push(`${focus.daysSinceAttention} days since real attention`);
  if (focus.latestHealthScore != null && focus.latestHealthScore <= 5)
    whyNowBits.push(`you rated its health ${focus.latestHealthScore}/10`);
  const whyNow =
    whyNowBits.length > 0
      ? whyNowBits.join("; ") + "."
      : "It is drifting from its desired state while nothing forces the issue — exactly when neglect compounds quietly.";

  // Why not the others — name the next two and why they can wait.
  const whyNotOther =
    others
      .slice(0, 3)
      .map((o) => {
        if (o.score <= 0) {
          return `• ${o.role.name}: operating fine — no pressure signals.`;
        }
        const top = o.reasons[0]?.label ?? "lower accumulated pressure";
        return `• ${o.role.name}: on the radar (${top}) but lower total pressure than ${focus.role.name}.`;
      })
      .join("\n") || "• No other active roles.";

  const nextAction = await suggestNextAction(focus);

  // Safe to ignore — roles that are genuinely healthy today.
  const safe = scored
    .filter((s) => s.score <= 1 && s.role.id !== focus.role.id)
    .map((s) => s.role.name);
  const safeToIgnore =
    safe.length > 0
      ? `${safe.join(", ")} — no action needed today.`
      : "Nothing is fully safe to ignore, but only the focus role needs you today.";

  // Avoidance alerts across all roles.
  const avoidance = scored
    .filter((s) => s.maxAvoidanceCount >= 2 && s.topAvoidedTaskTitle)
    .map((s) => `• ${s.role.name}: "${s.topAvoidedTaskTitle}" avoided ${s.maxAvoidanceCount}×`);
  const avoidanceAlerts =
    avoidance.length > 0 ? avoidance.join("\n") : "No repeated avoidance detected.";

  const summary = `Focus on ${focus.role.name} today. ${
    focus.overdueHighPriorityCount > 0
      ? "There's genuine urgency here."
      : "This is strategic/relational neglect, not a fire — which is exactly why it's easy to skip."
  }`;

  const [saved] = await db
    .insert(briefingsTable)
    .values({
      briefingDate,
      focusRoleId: focus.role.id,
      summary,
      whyThis,
      whyNow,
      whyNotOtherRoles: whyNotOther,
      next15MinuteAction: nextAction,
      safeToIgnore,
      avoidanceAlerts,
    })
    .returning();

  return saved;
}

export async function getLatestBriefing(): Promise<Briefing | null> {
  const [b] = await db
    .select()
    .from(briefingsTable)
    .orderBy(desc(briefingsTable.briefingDate), desc(briefingsTable.createdAt))
    .limit(1);
  return b ?? null;
}

/** Return today's briefing if it exists, otherwise generate it. */
export async function getOrCreateTodaysBriefing(): Promise<Briefing> {
  const today = todayStr();
  const [existing] = await db
    .select()
    .from(briefingsTable)
    .where(eq(briefingsTable.briefingDate, today))
    .orderBy(desc(briefingsTable.createdAt))
    .limit(1);
  if (existing) return existing;
  return generateBriefing(today);
}

/** Render a briefing as a conversational message for the chat surface. */
export function briefingToText(b: Briefing, focusRoleName?: string | null): string {
  const lines: string[] = [];
  lines.push(`**What's on tap today**`);
  if (b.summary) lines.push(b.summary);
  lines.push("");
  if (focusRoleName) lines.push(`**Focus role:** ${focusRoleName}`);
  if (b.whyThis) lines.push(`\n**Why this:**\n${b.whyThis}`);
  if (b.whyNow) lines.push(`\n**Why now:** ${b.whyNow}`);
  if (b.next15MinuteAction) lines.push(`\n**Next 15 minutes:** ${b.next15MinuteAction}`);
  if (b.safeToIgnore) lines.push(`\n**Safe to ignore:** ${b.safeToIgnore}`);
  if (b.avoidanceAlerts && b.avoidanceAlerts !== "No repeated avoidance detected.")
    lines.push(`\n**Avoidance alerts:**\n${b.avoidanceAlerts}`);
  return lines.join("\n");
}
