import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  projects as projectsTable,
  tasks as tasksTable,
} from "@/db";
import { scoreRoles } from "./briefing";
import {
  matchRole,
  listObservations,
  listCrossroads,
  listCheckins,
  listActivity,
} from "./operator";
import { startEndOfToday } from "./dates";

/**
 * Phase 3.5 — Natural Language Layer.
 *
 * Scout is the interface; Compass is the implementation. Selena asks naturally
 * ("what's going on with Mom?", "what am I avoiding?", "what's slipping?") and
 * should never need to know which entity holds the answer. This helper is the
 * routing layer: ONE call fans out across the relevant Compass entities and
 * returns a consolidated snapshot for Scout to synthesize into human language.
 *
 * Two shapes:
 *  - topic given  → everything about that thing (role + projects + tasks +
 *    observations + crossroads + attention + recent changes).
 *  - no topic     → a whole-life scan (what's slipping, what's being avoided,
 *    what keeps coming up, what changed) so broad/ambiguous questions still
 *    land on real data.
 */

function isOverdue(due: Date | null | undefined, startOfToday: Date): boolean {
  return !!due && new Date(due).getTime() < startOfToday.getTime();
}

export async function gatherAbout(topic?: string) {
  const t = topic?.trim() || "";
  const scored = await scoreRoles();
  const roleList = scored.map((s) => s.role);
  const { start } = startEndOfToday();

  // Resolve the topic to a role when possible (handles former names loosely too).
  let matched = t ? matchRole(t, roleList) : null;
  if (t && !matched) {
    const lc = t.toLowerCase();
    matched =
      roleList.find((r) => {
        const hist = Array.isArray(r.changeHistory)
          ? (r.changeHistory as { from?: string }[])
          : [];
        return hist.some((h) => h.from && h.from.toLowerCase().includes(lc));
      }) ?? null;
  }

  // Pull the cross-entity reads in parallel. Observations/crossroads/activity
  // are filtered by the topic text; role-scoped ones also by the role name.
  const [observations, crossroads, activity, checkins] = await Promise.all([
    listObservations(t || undefined),
    listCrossroads(t || undefined),
    listActivity(t || undefined, 12),
    listCheckins(3),
  ]);

  // ---- Topic mode: everything about one role/thing -------------------------
  if (matched) {
    const rs = scored.find((s) => s.role.id === matched!.id)!;

    const projects = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.roleId, matched.id), eq(projectsTable.status, "active")));

    const openTasks = await db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.roleId, matched.id), eq(tasksTable.status, "open")));

    // Observations/crossroads that mention this role even if the raw topic text didn't match.
    const roleObs = await listObservations(matched.name);
    const roleCross = await listCrossroads(matched.name);
    const mergeBy = <T extends { summary?: string; title?: string }>(a: T[], b: T[]) => {
      const seen = new Set<string>();
      return [...a, ...b].filter((x) => {
        const k = (x.summary ?? x.title ?? "").toLowerCase();
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    return {
      mode: "topic" as const,
      topic: t,
      role: {
        name: matched.name,
        status: matched.currentStatus,
        importance: matched.importanceLevel,
        attentionScore: rs.score,
        daysSinceAttention: rs.daysSinceAttention,
        openTaskCount: rs.openTaskCount,
        overdueHighPriority: rs.overdueHighPriorityCount,
        recentAttention: rs.recentAttentionByType,
        avoidedTask: rs.maxAvoidanceCount >= 2 ? rs.topAvoidedTaskTitle : null,
        selfRatedHealth: rs.latestHealthScore,
        topSignal: rs.reasons[0]?.label ?? null,
      },
      projects: projects.map((p) => ({ name: p.name, importance: p.strategicImportance })),
      openTasks: openTasks.map((t2) => ({
        title: t2.title,
        priority: t2.priority,
        overdue: isOverdue(t2.dueDate, start),
        avoidedCount: t2.avoidanceCount,
      })),
      observations: mergeBy(observations, roleObs),
      crossroads: mergeBy(crossroads, roleCross),
      recentChanges: activity,
    };
  }

  // ---- Whole-life mode: broad / ambiguous questions ------------------------
  // Neglected roles: meaningful score but little recent attention.
  const neglected = scored
    .filter((s) => s.score > 0)
    .slice(0, 5)
    .map((s) => ({
      name: s.role.name,
      attentionScore: s.score,
      daysSinceAttention: s.daysSinceAttention,
      topSignal: s.reasons[0]?.label ?? null,
      avoidedTask: s.maxAvoidanceCount >= 2 ? s.topAvoidedTaskTitle : null,
    }));

  // Overdue + most-avoided open tasks across all roles.
  const allOpen = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const roleName = new Map(roleList.map((r) => [r.id, r.name]));
  const overdue = allOpen
    .filter((t2) => isOverdue(t2.dueDate, start))
    .map((t2) => ({ title: t2.title, role: t2.roleId ? roleName.get(t2.roleId) ?? null : null }))
    .slice(0, 10);
  const avoided = allOpen
    .filter((t2) => t2.avoidanceCount >= 2)
    .sort((a, b) => b.avoidanceCount - a.avoidanceCount)
    .map((t2) => ({ title: t2.title, role: t2.roleId ? roleName.get(t2.roleId) ?? null : null, avoidedCount: t2.avoidanceCount }))
    .slice(0, 6);

  return {
    mode: "whole_life" as const,
    topic: t || null,
    neglectedRoles: neglected,
    observations,
    crossroads,
    overdueTasks: overdue,
    avoidedTasks: avoided,
    recentCheckins: checkins,
    recentChanges: activity,
  };
}
