import { eq } from "drizzle-orm";
import {
  db,
  projects as projectsTable,
  tasks as tasksTable,
  type Project,
} from "@/db";
import { scoreRoles } from "./briefing";
import {
  matchRole,
  listObservations,
  listCrossroads,
  listCheckins,
  listActivity,
  listIdeas,
  getCrossroadDetail,
  searchKnowledge,
} from "./operator";
import { startEndOfToday } from "./dates";

/**
 * Phase 3.5/3.7 — Natural Language Layer + qualitative retrieval.
 *
 * Scout is the interface; Compass is the implementation. Selena asks naturally
 * ("what's going on with Gifford & Co.?", "how's Thunder Kittens?", "what am I
 * avoiding?") and should never need to know which entity holds the answer. ONE
 * call fans out across roles, projects, crossroads, observations, ideas, and
 * tasks and returns a consolidated snapshot — including the QUALITATIVE fields
 * (descriptions, mission, desired outcomes) so Scout never calls a populated
 * role/project "blank."
 *
 * Topic resolution is no longer roles-only: a topic resolves to roles AND
 * projects AND crossroads (by name OR descriptive text), and each match pulls
 * in its linked context.
 */

function isOverdue(due: Date | null | undefined, startOfToday: Date): boolean {
  return !!due && new Date(due).getTime() < startOfToday.getTime();
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Does `text` plausibly refer to `topic`? Phrase-contains or significant-token overlap. */
function topicHits(text: string | null | undefined, topic: string): boolean {
  if (!text) return false;
  const T = norm(text);
  const q = norm(topic);
  if (!q || !T) return false;
  if (T.includes(q)) return true;
  const toks = q.split(" ").filter((w) => w.length >= 4);
  if (toks.length === 0) return false;
  const overlap = toks.filter((w) => T.includes(w)).length;
  return overlap >= 2 || (toks.length === 1 && overlap === 1);
}

export async function gatherAbout(topic?: string) {
  const t = topic?.trim() || "";
  const scored = await scoreRoles();
  const roleList = scored.map((s) => s.role);
  const { start } = startEndOfToday();

  // Cross-entity reads, filtered by the topic text.
  const [observations, crossroads, activity, checkins, ideas] = await Promise.all([
    listObservations(t || undefined),
    listCrossroads(t || undefined),
    listActivity(t || undefined, 12),
    listCheckins(3),
    listIdeas(t || undefined),
  ]);

  if (!t) {
    return wholeLife(scored, roleList, start, { observations, crossroads, activity, checkins });
  }

  // ---- Resolve the topic to entities (roles, projects, crossroads) ----------
  const lc = t.toLowerCase();

  // Role: by name, by former name, OR by descriptive text (so "Thunder Kittens"
  // resolves to Coach once the role description mentions it).
  let matchedRole =
    matchRole(t, roleList) ||
    roleList.find((r) => {
      const hist = Array.isArray(r.changeHistory) ? (r.changeHistory as { from?: string }[]) : [];
      return hist.some((h) => h.from && h.from.toLowerCase().includes(lc));
    }) ||
    roleList.find(
      (r) =>
        topicHits(r.description, t) ||
        topicHits(r.mission, t) ||
        topicHits(r.desiredState, t)
    ) ||
    null;

  // Projects: by name/description, plus the matched role's projects.
  const allProjects = await db.select().from(projectsTable);
  const roleNameById = new Map(roleList.map((r) => [r.id, r.name]));
  let matchedProjects = allProjects.filter(
    (p) => topicHits(p.name, t) || topicHits(p.description, t) || topicHits(p.desiredOutcome, t)
  );
  // If a project matched but no role did, adopt the project's linked role.
  if (!matchedRole && matchedProjects.length) {
    const rid = matchedProjects[0].roleId;
    matchedRole = rid ? roleList.find((r) => r.id === rid) ?? null : null;
  }
  // If a role matched, fold in its active projects too.
  if (matchedRole) {
    const rolePs = allProjects.filter((p) => p.roleId === matchedRole!.id && p.status === "active");
    for (const p of rolePs) if (!matchedProjects.some((m) => m.id === p.id)) matchedProjects.push(p);
  }
  // Prefer active projects in the output, but keep matched archived ones visible.
  matchedProjects = matchedProjects.sort((a, b) => (a.status === "active" ? -1 : 1) - (b.status === "active" ? -1 : 1));

  // Crossroad: full detail for the best title/description match.
  const crossroadDetail = crossroads.length ? await getCrossroadDetail(t) : null;

  const matchedAnything = !!matchedRole || matchedProjects.length > 0 || crossroads.length > 0;
  if (!matchedAnything) {
    return wholeLife(scored, roleList, start, { observations, crossroads, activity, checkins });
  }

  // ---- Tasks relevant to the topic -----------------------------------------
  const allOpen = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const projectIds = new Set(matchedProjects.map((p) => p.id));
  const relevantTasks = allOpen
    .filter(
      (t2) =>
        (matchedRole && t2.roleId === matchedRole.id) ||
        (t2.projectId && projectIds.has(t2.projectId)) ||
        topicHits(t2.title, t)
    )
    .slice(0, 12)
    .map((t2) => ({
      title: t2.title,
      priority: t2.priority,
      overdue: isOverdue(t2.dueDate, start),
      avoidedCount: t2.avoidanceCount,
      role: t2.roleId ? roleNameById.get(t2.roleId) ?? null : null,
    }));

  // Observations/crossroads that name the matched role even if the raw topic didn't.
  const roleObs = matchedRole ? await listObservations(matchedRole.name) : [];
  const roleCross = matchedRole ? await listCrossroads(matchedRole.name) : [];
  const mergeBy = <T extends { summary?: string; title?: string }>(a: T[], b: T[]) => {
    const seen = new Set<string>();
    return [...a, ...b].filter((x) => {
      const k = (x.summary ?? x.title ?? "").toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const rs = matchedRole ? scored.find((s) => s.role.id === matchedRole!.id) : null;

  // Knowledge notes — the actual SUBSTANCE (full bodies) for this topic/role/project.
  // Role-first (so every note in the area surfaces), then project, then free text.
  const knowledge = await searchKnowledge(
    matchedRole
      ? { roleName: matchedRole.name, limit: 15 }
      : matchedProjects.length
        ? { projectName: matchedProjects[0].name, limit: 15 }
        : { query: t, limit: 15 }
  );

  return {
    mode: "topic" as const,
    topic: t,
    knowledge,
    resolvedTo: {
      role: matchedRole?.name ?? null,
      projects: matchedProjects.map((p) => p.name),
      crossroad: crossroadDetail?.ok ? crossroadDetail.title : null,
    },
    role: matchedRole
      ? {
          name: matchedRole.name,
          importance: matchedRole.importanceLevel,
          currentStatus: matchedRole.currentStatus,
          // Qualitative definition — so Scout never calls a populated role "blank".
          description: matchedRole.description,
          mission: matchedRole.mission,
          desiredState: matchedRole.desiredState,
          warningSigns: matchedRole.warningSigns,
          maintenanceMinimum: matchedRole.maintenanceMinimum,
          // Health signals.
          attentionScore: rs?.score ?? null,
          daysSinceAttention: rs?.daysSinceAttention ?? null,
          openTaskCount: rs?.openTaskCount ?? 0,
          overdueHighPriority: rs?.overdueHighPriorityCount ?? 0,
          recentAttention: rs?.recentAttentionByType ?? {},
          avoidedTask: rs && rs.maxAvoidanceCount >= 2 ? rs.topAvoidedTaskTitle : null,
          selfRatedHealth: rs?.latestHealthScore ?? null,
          topSignal: rs?.reasons[0]?.label ?? null,
        }
      : null,
    projects: matchedProjects.map((p: Project) => ({
      name: p.name,
      description: p.description,
      desiredOutcome: p.desiredOutcome,
      status: p.status,
      role: p.roleId ? roleNameById.get(p.roleId) ?? null : null,
      strategicImportance: p.strategicImportance,
      lastMeaningfulProgressAt: p.lastMeaningfulProgressAt ? p.lastMeaningfulProgressAt.toISOString() : null,
    })),
    crossroad: crossroadDetail?.ok ? crossroadDetail : null,
    crossroads: mergeBy(crossroads, roleCross),
    observations: mergeBy(observations, roleObs),
    ideas,
    tasks: relevantTasks,
    recentChanges: activity,
  };
}

type Bundle = {
  observations: Awaited<ReturnType<typeof listObservations>>;
  crossroads: Awaited<ReturnType<typeof listCrossroads>>;
  activity: Awaited<ReturnType<typeof listActivity>>;
  checkins: Awaited<ReturnType<typeof listCheckins>>;
};

async function wholeLife(
  scored: Awaited<ReturnType<typeof scoreRoles>>,
  roleList: Awaited<ReturnType<typeof scoreRoles>>[number]["role"][],
  start: Date,
  { observations, crossroads, activity, checkins }: Bundle
) {
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
    topic: null,
    neglectedRoles: neglected,
    observations,
    crossroads,
    overdueTasks: overdue,
    avoidedTasks: avoided,
    recentCheckins: checkins,
    recentChanges: activity,
  };
}
