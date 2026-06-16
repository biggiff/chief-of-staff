import { and, desc, eq, isNull, ilike, lte } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  checkins as checkinsTable,
  checkinRoleScores as checkinRoleScoresTable,
  roleAttentionEvents as attentionTable,
  workingAgreements as agreementsTable,
  decisions as decisionsTable,
  crossroadDiscussions as discussionsTable,
  insights as insightsTable,
  activityLog as activityTable,
  memories as memoriesTable,
  reminders as remindersTable,
  appSettings as settingsTable,
  messages as messagesTable,
  workflowStates as workflowStatesTable,
  type AttentionType,
  type Priority,
  type Role,
  type MemoryType,
  type Confidence,
} from "@/db";
import {
  createTodoistTask,
  closeTodoistTask,
  reopenTodoistTask,
  deleteTodoistTask,
  findActiveTodoistTask,
} from "./integrations/todoist";
import { formatDate, formatTime } from "./dates";

/**
 * Compass operator layer.
 *
 * Every mutation Scout makes from chat goes through here so it is (a) consistent
 * with the backstage forms, (b) logged to activity_log, and (c) reversible via
 * undoLast(). Todoist stays the source of truth for tasks — task writes hit the
 * Todoist API first, then mirror into Compass.
 */

async function logActivity(entry: {
  actionKind: string;
  summary: string;
  entityTable?: string;
  entityId?: string;
  undoPayload?: Record<string, unknown>;
  conversationId?: string | null;
  source?: string;
}) {
  await db.insert(activityTable).values({
    actionKind: entry.actionKind,
    summary: entry.summary,
    entityTable: entry.entityTable ?? null,
    entityId: entry.entityId ?? null,
    undoPayloadJson: entry.undoPayload ?? null,
    conversationId: entry.conversationId ?? null,
    source: entry.source ?? "chat",
  });
  // Any write invalidates version-keyed caches (e.g. role scoring).
  const { bumpDataVersion } = await import("./cache");
  bumpDataVersion();
}

export async function activeRoles(): Promise<Role[]> {
  return db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));
}

export function matchRole(name: string | undefined | null, roles: Role[]): Role | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  const sorted = [...roles].sort((a, b) => b.name.length - a.name.length);
  return (
    sorted.find((r) => r.name.toLowerCase() === lower) ||
    sorted.find((r) => r.name.toLowerCase().includes(lower)) ||
    sorted.find((r) => lower.includes(r.name.toLowerCase())) ||
    null
  );
}

/** Fuzzy-match an open task by free-text query. Returns best + whether confident. */
export async function findOpenTask(query: string) {
  const open = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const q = query.toLowerCase().trim();
  const qWords = q.split(/\W+/).filter(Boolean);
  const scored = open
    .map((t) => {
      const title = t.title.toLowerCase();
      let score = 0;
      if (title === q) score = 100;
      else if (title.includes(q) || q.includes(title)) score = 80;
      else {
        const tw = new Set(title.split(/\W+/).filter(Boolean));
        const overlap = qWords.filter((w) => tw.has(w)).length;
        score = (overlap / Math.max(qWords.length, 1)) * 60;
      }
      return { task: t, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];
  const confident = !!best && best.score >= 50 && (!second || best.score - second.score >= 15);
  return { best: best?.task ?? null, confident, candidates: scored.slice(0, 5).filter((s) => s.score >= 30) };
}

/* ------------------------------- Actions ------------------------------- */

export async function logAttention(input: {
  role: Role;
  attentionType: AttentionType;
  durationMinutes?: number | null;
  projectId?: string | null;
  notes?: string | null;
  occurredAt?: Date | null; // when it actually happened (defaults to now)
  conversationId?: string | null;
}) {
  const occurredAt = input.occurredAt ?? new Date();
  const [event] = await db
    .insert(attentionTable)
    .values({
      roleId: input.role.id,
      projectId: input.projectId ?? null,
      attentionType: input.attentionType,
      durationMinutes: input.durationMinutes ?? null,
      notes: input.notes ?? null,
      occurredAt,
      source: "chat",
    })
    .returning();
  // The role's "last meaningful attention" should reflect the most recent activity
  // by when it HAPPENED — only advance it if this event is newer than what's stored.
  const [r] = await db.select().from(rolesTable).where(eq(rolesTable.id, input.role.id)).limit(1);
  if (!r?.lastMeaningfulAttentionAt || occurredAt > r.lastMeaningfulAttentionAt) {
    await db
      .update(rolesTable)
      .set({ lastMeaningfulAttentionAt: occurredAt, updatedAt: new Date() })
      .where(eq(rolesTable.id, input.role.id));
  }

  const dur = input.durationMinutes ? ` (${input.durationMinutes} min)` : "";
  const backlog = input.occurredAt ? ` on ${formatDate(occurredAt)}` : "";
  const summary = `Logged ${input.attentionType.replace("_", " ")} attention to ${input.role.name}${dur}${backlog}`;
  await logActivity({
    actionKind: "log_attention",
    summary,
    entityTable: "role_attention_events",
    entityId: event.id,
    undoPayload: { eventId: event.id },
    conversationId: input.conversationId,
  });
  return { event, summary };
}

export async function createTask(input: {
  title: string;
  role?: Role | null;
  projectId?: string | null;
  priority?: Priority;
  dueString?: string | null;
  conversationId?: string | null;
}) {
  // Todoist is the source of truth — create there first.
  const created = await createTodoistTask({
    content: input.title,
    priority: input.priority,
    dueString: input.dueString,
  });

  // Capture the resolved due date/time from Todoist's response.
  const dueRaw = created.due?.datetime || created.due?.date || null;
  const hasTime = !!created.due?.datetime;
  const dueDate = dueRaw ? new Date(dueRaw) : null;
  const dueLabel = dueDate
    ? hasTime
      ? `${formatDate(dueDate)} at ${formatTime(dueDate)}`
      : formatDate(dueDate)
    : null;

  const [task] = await db
    .insert(tasksTable)
    .values({
      title: input.title.slice(0, 200),
      roleId: input.role?.id ?? null,
      projectId: input.projectId ?? null,
      priority: input.priority ?? "medium",
      status: "open",
      dueDate,
      source: "todoist",
      externalId: created.id,
      todoistProjectId: created.project_id ?? null,
    })
    .returning();

  const summary = `Created task "${input.title}" in Todoist${dueLabel ? ` for ${dueLabel}` : ""}${input.role ? ` (${input.role.name})` : ""}`;
  await logActivity({
    actionKind: "create_task",
    summary,
    entityTable: "tasks",
    entityId: task.id,
    undoPayload: { taskId: task.id, todoistId: created.id },
    conversationId: input.conversationId,
  });
  return { task, summary, dueLabel };
}

export async function completeTask(input: { task: typeof tasksTable.$inferSelect; conversationId?: string | null }) {
  const { task } = input;
  if (task.externalId) {
    await closeTodoistTask(task.externalId).catch(() => {});
  }
  await db
    .update(tasksTable)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(tasksTable.id, task.id));

  const summary = `Completed "${task.title}"`;
  await logActivity({
    actionKind: "complete_task",
    summary,
    entityTable: "tasks",
    entityId: task.id,
    undoPayload: { taskId: task.id, todoistId: task.externalId },
    conversationId: input.conversationId,
  });
  return { summary };
}

/**
 * Complete a task by searching Todoist LIVE (not the Compass mirror). Fallback for
 * when the mirror is stale or doesn't have the item (e.g. grocery items, things
 * just added). Closes in Todoist + reflects into the mirror if present.
 */
export async function completeTaskLive(query: string, conversationId?: string | null): Promise<{
  ok: boolean; summary?: string; error?: string; needsClarification?: boolean; candidates?: string[];
}> {
  const { best, confident, candidates } = await findActiveTodoistTask(query);
  if (!best) return { ok: false, error: "No matching open task found in Todoist." };
  if (!confident) return { ok: false, needsClarification: true, candidates: candidates.map((c) => c.content) };
  await closeTodoistTask(best.id).catch(() => {});
  // Reflect into the mirror if the task happens to be mirrored.
  await db.update(tasksTable).set({ status: "completed", completedAt: new Date(), updatedAt: new Date() }).where(eq(tasksTable.externalId, best.id));
  const summary = `Completed "${best.content}"`;
  await logActivity({
    actionKind: "complete_task_live",
    summary,
    entityTable: "tasks",
    undoPayload: { todoistId: best.id },
    conversationId,
  });
  return { ok: true, summary };
}

export async function createIdea(input: {
  title: string;
  notes?: string | null;
  role?: Role | null;
  conversationId?: string | null;
}) {
  const [idea] = await db
    .insert(ideasTable)
    .values({
      title: input.title.slice(0, 200),
      notes: input.notes ?? input.title,
      roleId: input.role?.id ?? null,
      status: "captured",
    })
    .returning();
  const summary = `Captured idea "${input.title}"${input.role ? ` (${input.role.name})` : ""}`;
  await logActivity({
    actionKind: "create_idea",
    summary,
    entityTable: "ideas",
    entityId: idea.id,
    undoPayload: { ideaId: idea.id },
    conversationId: input.conversationId,
  });
  return { idea, summary };
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Find existing OPEN tasks similar to a title (guards against duplicate creation). */
export async function findSimilarOpenTasks(title: string) {
  const open = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const q = normalizeText(title);
  const qWords = q.split(" ").filter(Boolean);
  return open
    .map((task) => {
      const t = normalizeText(task.title);
      let score = 0;
      if (t === q) score = 100;
      else if (t.includes(q) || q.includes(t)) score = 85;
      else {
        const tw = new Set(t.split(" ").filter(Boolean));
        const overlap = qWords.filter((w) => tw.has(w)).length;
        score = (overlap / Math.max(qWords.length, 1)) * 70;
      }
      return { task, score };
    })
    .filter((x) => x.score >= 55)
    .sort((a, b) => b.score - a.score);
}

/** Find existing ideas (active + archived) similar to a title. */
export async function findSimilarIdeas(title: string) {
  const all = await db.select().from(ideasTable);
  const q = normalizeText(title);
  const qWords = q.split(" ").filter(Boolean);
  return all
    .map((idea) => {
      const t = normalizeText(idea.title);
      let score = 0;
      if (t === q) score = 100;
      else if (t.includes(q) || q.includes(t)) score = 85;
      else {
        const tw = new Set(t.split(" ").filter(Boolean));
        const overlap = qWords.filter((w) => tw.has(w)).length;
        score = (overlap / Math.max(qWords.length, 1)) * 70;
      }
      return { idea, score };
    })
    .filter((x) => x.score >= 55)
    .sort((a, b) => b.score - a.score);
}

export async function appendIdeaNote(input: {
  ideaQuery: string;
  note: string;
  conversationId?: string | null;
}) {
  // Resolve by closest title match.
  const matches = await findSimilarIdeas(input.ideaQuery);
  const idea = matches[0]?.idea;
  if (!idea) return { ok: false, summary: "Couldn't find that idea." };
  const newNotes = [idea.notes, input.note].filter(Boolean).join("\n");
  await db.update(ideasTable).set({ notes: newNotes, updatedAt: new Date() }).where(eq(ideasTable.id, idea.id));
  const summary = `Added a note to idea "${idea.title}"`;
  await logActivity({
    actionKind: "append_idea_note",
    summary,
    entityTable: "ideas",
    entityId: idea.id,
    undoPayload: { ideaId: idea.id, prevNotes: idea.notes },
    conversationId: input.conversationId,
  });
  return { ok: true, summary };
}

export async function reassign(input: {
  entityTable: "tasks" | "ideas";
  entityId: string;
  role?: Role | null;
  projectId?: string | null;
  conversationId?: string | null;
}) {
  const isTask = input.entityTable === "tasks";
  const table = isTask ? tasksTable : ideasTable;
  const [prior] = await db.select().from(table).where(eq(table.id, input.entityId)).limit(1);
  if (!prior) return { summary: "Couldn't find that item to reassign." };
  const priorProjectId = (prior as { projectId?: string | null }).projectId ?? null;

  const setObj: Record<string, unknown> = {
    roleId: input.role ? input.role.id : prior.roleId,
    updatedAt: new Date(),
  };
  // Only tasks carry a project association.
  if (isTask) setObj.projectId = input.projectId !== undefined ? input.projectId : priorProjectId;

  await db.update(table).set(setObj as never).where(eq(table.id, input.entityId));

  const summary = `Moved "${prior.title}" to ${input.role?.name ?? "its project"}`;
  await logActivity({
    actionKind: "reassign",
    summary,
    entityTable: input.entityTable,
    entityId: input.entityId,
    undoPayload: {
      entityTable: input.entityTable,
      entityId: input.entityId,
      prevRoleId: prior.roleId,
      prevProjectId: priorProjectId,
    },
    conversationId: input.conversationId,
  });
  return { summary };
}

export async function recordPushback(input: { role: Role; conversationId?: string | null }) {
  const [skipped] = await db
    .select()
    .from(tasksTable)
    .where(and(eq(tasksTable.roleId, input.role.id), eq(tasksTable.status, "open")))
    .orderBy(desc(tasksTable.avoidanceCount))
    .limit(1);
  if (skipped) {
    await db
      .update(tasksTable)
      .set({ avoidanceCount: skipped.avoidanceCount + 1, updatedAt: new Date() })
      .where(eq(tasksTable.id, skipped.id));
    await logActivity({
      actionKind: "record_pushback",
      summary: `Flagged pushback on ${input.role.name}`,
      entityTable: "tasks",
      entityId: skipped.id,
      undoPayload: { taskId: skipped.id, prevAvoidance: skipped.avoidanceCount },
      conversationId: input.conversationId,
    });
  } else {
    await logActivity({
      actionKind: "record_pushback",
      summary: `Flagged pushback on ${input.role.name}`,
      conversationId: input.conversationId,
    });
  }
  return { skipped: skipped ?? null };
}

export async function saveCheckin(input: {
  energy?: number | null;
  overwhelm?: number | null;
  win?: string | null;
  concern?: string | null;
  avoiding?: string | null;
  notes?: string | null;
  conversationId?: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [checkin] = await db
    .insert(checkinsTable)
    .values({
      checkinDate: today,
      energyLevel: input.energy ?? null,
      overwhelmLevel: input.overwhelm ?? null,
      notes: [input.win && `Win: ${input.win}`, input.concern && `Concern: ${input.concern}`, input.avoiding && `Avoiding: ${input.avoiding}`, input.notes]
        .filter(Boolean)
        .join(" | ") || null,
    })
    .returning();
  const summary = `Saved check-in (energy ${input.energy ?? "—"}, overwhelm ${input.overwhelm ?? "—"})`;
  await logActivity({
    actionKind: "save_checkin",
    summary,
    entityTable: "checkins",
    entityId: checkin.id,
    undoPayload: { checkinId: checkin.id },
    conversationId: input.conversationId,
  });
  // A check-in is a strong signal — let the Observation Engine take a look (throttled).
  try {
    const { runObservationPass } = await import("./observation-engine");
    await runObservationPass();
  } catch (err) {
    console.error("observation pass failed", err);
  }
  return { checkin, summary };
}

export async function addWorkingAgreement(input: {
  text: string;
  category?: string;
  conversationId?: string | null;
}) {
  const [row] = await db
    .insert(agreementsTable)
    .values({ text: input.text.slice(0, 500), category: input.category ?? "behavior", source: "learned" })
    .returning();
  const summary = `Saved a working agreement: "${input.text.slice(0, 80)}"`;
  await logActivity({
    actionKind: "working_agreement",
    summary,
    entityTable: "working_agreements",
    entityId: row.id,
    undoPayload: { agreementId: row.id },
    conversationId: input.conversationId,
  });
  return { summary };
}

/* ------------------- Compass structure (roles/projects) ---------------- */

/** Full structured view of Compass so Scout can "see everything." */
export async function getCompassOverview() {
  const [allRoles, allProjects, openTasks, allIdeas] = await Promise.all([
    db.select().from(rolesTable).where(isNull(rolesTable.archivedAt)),
    db.select().from(projectsTable),
    db.select().from(tasksTable).where(eq(tasksTable.status, "open")),
    db.select().from(ideasTable),
  ]);
  const activeProjects = allProjects.filter((p) => p.status === "active");
  return {
    roles: allRoles.map((r) => ({
      name: r.name,
      status: r.currentStatus,
      importance: r.importanceLevel,
      openTasks: openTasks.filter((t) => t.roleId === r.id).length,
      projects: activeProjects.filter((p) => p.roleId === r.id).map((p) => p.name),
    })),
    projects: activeProjects.map((p) => ({
      name: p.name,
      role: allRoles.find((r) => r.id === p.roleId)?.name ?? null,
      status: p.status,
    })),
    counts: {
      roles: allRoles.length,
      activeProjects: activeProjects.length,
      openTasks: openTasks.length,
      ideas: allIdeas.filter((i) => i.status !== "archived").length,
    },
  };
}

async function findProject(name: string) {
  const [p] = await db.select().from(projectsTable).where(ilike(projectsTable.name, `%${name}%`)).limit(1);
  return p ?? null;
}

export async function manageRole(input: {
  action: "create" | "update" | "archive";
  roleName?: string;
  name?: string;
  importance?: string;
  status?: string;
  reason?: string; // why a significant change (esp. rename) is being made
  description?: string;
  mission?: string;
  desiredState?: string;
  warningSigns?: string;
  maintenanceMinimum?: string;
  conversationId?: string | null;
}) {
  const roles = await activeRoles();

  if (input.action === "create") {
    if (!input.name) return { ok: false, summary: "Need a name to create a role." };
    const [r] = await db
      .insert(rolesTable)
      .values({
        name: input.name,
        importanceLevel: (input.importance ?? "medium") as never,
        currentStatus: (input.status ?? "maintaining") as never,
        description: input.description ?? null,
        mission: input.mission ?? null,
        desiredState: input.desiredState ?? null,
        warningSigns: input.warningSigns ?? null,
        maintenanceMinimum: input.maintenanceMinimum ?? null,
      })
      .returning();
    const summary = `Created role "${r.name}"`;
    await logActivity({ actionKind: "role", summary, entityTable: "roles", entityId: r.id, undoPayload: { op: "create", id: r.id }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  const role = matchRole(input.roleName, roles);
  if (!role) return { ok: false, summary: "Couldn't find that role.", roles: roles.map((r) => r.name) };

  if (input.action === "archive") {
    await db.update(rolesTable).set({ archivedAt: new Date() }).where(eq(rolesTable.id, role.id));
    const summary = `Archived role "${role.name}"`;
    await logActivity({ actionKind: "role", summary, entityTable: "roles", entityId: role.id, undoPayload: { op: "archive", id: role.id }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  // update
  const isRename = !!input.name && input.name !== role.name;
  const prevHistory = Array.isArray(role.changeHistory) ? (role.changeHistory as unknown[]) : [];
  const newHistory = isRename
    ? [...prevHistory, { from: role.name, to: input.name, reason: input.reason ?? null, at: new Date().toISOString() }]
    : prevHistory;
  const prev = {
    name: role.name,
    importanceLevel: role.importanceLevel,
    currentStatus: role.currentStatus,
    changeHistory: role.changeHistory,
    description: role.description,
    mission: role.mission,
    desiredState: role.desiredState,
    warningSigns: role.warningSigns,
    maintenanceMinimum: role.maintenanceMinimum,
  };
  await db
    .update(rolesTable)
    .set({
      name: input.name ?? role.name,
      importanceLevel: (input.importance ?? role.importanceLevel) as never,
      currentStatus: (input.status ?? role.currentStatus) as never,
      changeHistory: newHistory as never,
      description: input.description ?? role.description,
      mission: input.mission ?? role.mission,
      desiredState: input.desiredState ?? role.desiredState,
      warningSigns: input.warningSigns ?? role.warningSigns,
      maintenanceMinimum: input.maintenanceMinimum ?? role.maintenanceMinimum,
      updatedAt: new Date(),
    })
    .where(eq(rolesTable.id, role.id));
  const changedFields = [
    input.description != null && "description",
    input.mission != null && "mission",
    input.desiredState != null && "desired state",
    input.warningSigns != null && "warning signs",
    input.maintenanceMinimum != null && "maintenance minimum",
  ].filter(Boolean);
  const summary = isRename
    ? `Renamed role "${role.name}" → "${input.name}"${input.reason ? ` (${input.reason})` : ""}`
    : `Updated role "${role.name}"${changedFields.length ? ` (${changedFields.join(", ")})` : ""}`;
  await logActivity({ actionKind: "role", summary, entityTable: "roles", entityId: role.id, undoPayload: { op: "update", id: role.id, prev }, conversationId: input.conversationId });
  return { ok: true, summary };
}

export async function manageProject(input: {
  action: "create" | "update" | "archive";
  projectName?: string;
  name?: string;
  roleName?: string;
  status?: string;
  description?: string;
  desiredOutcome?: string;
  conversationId?: string | null;
}) {
  const roles = await activeRoles();
  const role = input.roleName ? matchRole(input.roleName, roles) : null;

  if (input.action === "create") {
    if (!input.name) return { ok: false, summary: "Need a name to create a project." };
    const [p] = await db
      .insert(projectsTable)
      .values({ name: input.name, roleId: role?.id ?? null, status: (input.status ?? "active") as never, description: input.description ?? null, desiredOutcome: input.desiredOutcome ?? null })
      .returning();
    const summary = `Created project "${p.name}"${role ? ` under ${role.name}` : ""}`;
    await logActivity({ actionKind: "project", summary, entityTable: "projects", entityId: p.id, undoPayload: { op: "create", id: p.id }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  const project = input.projectName ? await findProject(input.projectName) : null;
  if (!project) return { ok: false, summary: "Couldn't find that project." };

  if (input.action === "archive") {
    const prev = { status: project.status };
    await db.update(projectsTable).set({ status: "archived", updatedAt: new Date() }).where(eq(projectsTable.id, project.id));
    const summary = `Archived project "${project.name}"`;
    await logActivity({ actionKind: "project", summary, entityTable: "projects", entityId: project.id, undoPayload: { op: "archive", id: project.id, prev }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  const prev = { name: project.name, roleId: project.roleId, status: project.status, description: project.description, desiredOutcome: project.desiredOutcome };
  await db
    .update(projectsTable)
    .set({
      name: input.name ?? project.name,
      roleId: input.roleName ? role?.id ?? project.roleId : project.roleId,
      status: (input.status ?? project.status) as never,
      description: input.description ?? project.description,
      desiredOutcome: input.desiredOutcome ?? project.desiredOutcome,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, project.id));
  const changed = [input.description != null && "description", input.desiredOutcome != null && "desired outcome"].filter(Boolean);
  const summary = `Updated project "${project.name}"${changed.length ? ` (${changed.join(", ")})` : ""}`;
  await logActivity({ actionKind: "project", summary, entityTable: "projects", entityId: project.id, undoPayload: { op: "update", id: project.id, prev }, conversationId: input.conversationId });
  return { ok: true, summary };
}

/* ----------------------------- Crossroads ------------------------------ */

// Fuzzy match a decision by title (token overlap) so "doughrway pricing",
// "free vs paid", etc. all resolve to the one canonical crossroad — and so the
// create-dedup catches near-duplicate titles.
async function findDecision(query: string) {
  const rows = await db.select().from(decisionsTable);
  const q = normalizeText(query);
  const qWords = q.split(" ").filter(Boolean);
  const scored = rows
    .map((d) => {
      const t = normalizeText(d.title);
      let s = 0;
      if (t === q) s = 100;
      else if (t.includes(q) || q.includes(t)) s = 85;
      else {
        const tw = new Set(t.split(" ").filter(Boolean));
        const overlap = qWords.filter((w) => tw.has(w)).length;
        s = (overlap / Math.max(qWords.length, 1)) * 70;
      }
      return { d, s };
    })
    .filter((x) => x.s >= 45)
    .sort((a, b) => b.s - a.s);
  return scored[0]?.d ?? null;
}

export async function listCrossroads(query?: string, includeArchived = false) {
  const rows = await db.select().from(decisionsTable).orderBy(desc(decisionsTable.updatedAt));
  const q = query?.toLowerCase().trim();
  return rows
    .filter((d) => (includeArchived ? true : d.status !== "archived"))
    .filter((d) => !q || normalizeText(d.title).includes(normalizeText(q)) || (d.description ?? "").toLowerCase().includes(q))
    .map((d) => ({
      title: d.title,
      status: d.status,
      currentLeaning: d.currentLeaning ?? d.decision ?? null,
      unresolvedConcerns: d.unresolvedConcerns ?? null,
      revisitCount: d.revisitCount,
    }));
}

/** Full Crossroad detail incl. the discussion timeline. */
export async function getCrossroadDetail(query: string) {
  const d = await findDecision(query);
  if (!d) return { ok: false, summary: "Couldn't find that crossroad." };
  const history = await db
    .select()
    .from(discussionsTable)
    .where(eq(discussionsTable.decisionId, d.id))
    .orderBy(discussionsTable.createdAt);
  return {
    ok: true,
    title: d.title,
    description: d.description,
    status: d.status,
    currentLeaning: d.currentLeaning ?? d.decision ?? null,
    unresolvedConcerns: d.unresolvedConcerns ?? null,
    revisitCount: d.revisitCount,
    firstDiscussedAt: d.firstDiscussedAt?.toISOString() ?? null,
    latestDiscussedAt: d.latestDiscussedAt?.toISOString() ?? null,
    timeline: history.map((h) => ({
      at: h.createdAt.toISOString(),
      leaning: h.leaning,
      concerns: h.concerns,
      note: h.note,
    })),
  };
}

export async function manageCrossroad(input: {
  action: "create" | "update" | "archive";
  query?: string;
  title?: string;
  description?: string;
  status?: string;
  currentLeaning?: string;
  unresolvedConcerns?: string;
  reasoning?: string;
  whatChanged?: string; // note for this discussion entry
  conversationId?: string | null;
}) {
  if (input.action === "create") {
    if (!input.title) return { ok: false, summary: "Need a title to create a crossroad." };
    // Guard against duplicates (incl. a model double-call in one turn).
    const dup = await findDecision(input.title);
    if (dup && dup.status !== "archived") {
      return { ok: true, summary: `That crossroad already exists ("${dup.title}").`, duplicate: true, existingTitle: dup.title };
    }
    const now = new Date();
    const [d] = await db
      .insert(decisionsTable)
      .values({
        title: input.title.slice(0, 200),
        description: input.description ?? null,
        status: (input.status ?? "active") as never,
        currentLeaning: input.currentLeaning ?? null,
        unresolvedConcerns: input.unresolvedConcerns ?? null,
        reasoning: input.reasoning ?? null,
        firstDiscussedAt: now,
        latestDiscussedAt: now,
        revisitCount: 0,
      })
      .returning();
    // First timeline entry.
    await db.insert(discussionsTable).values({
      decisionId: d.id,
      leaning: input.currentLeaning ?? null,
      concerns: input.unresolvedConcerns ?? null,
      note: input.whatChanged ?? "First discussed.",
    });
    const summary = `Opened crossroad "${d.title}"`;
    await logActivity({ actionKind: "crossroad", summary, entityTable: "decisions", entityId: d.id, undoPayload: { op: "create", id: d.id }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  const d = input.query ? await findDecision(input.query) : null;
  if (!d) return { ok: false, summary: "Couldn't find that crossroad." };

  if (input.action === "archive") {
    const prev = { status: d.status };
    await db.update(decisionsTable).set({ status: "archived", updatedAt: new Date() }).where(eq(decisionsTable.id, d.id));
    const summary = `Archived crossroad "${d.title}"`;
    await logActivity({ actionKind: "crossroad", summary, entityTable: "decisions", entityId: d.id, undoPayload: { op: "archive", id: d.id, prev }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  // update — counts as a revisit; append a timeline entry capturing this discussion.
  const prev = {
    title: d.title, description: d.description, status: d.status,
    currentLeaning: d.currentLeaning, unresolvedConcerns: d.unresolvedConcerns, reasoning: d.reasoning,
  };
  await db
    .update(decisionsTable)
    .set({
      title: input.title ?? d.title,
      description: input.description ?? d.description,
      status: (input.status ?? d.status) as never,
      currentLeaning: input.currentLeaning ?? d.currentLeaning,
      unresolvedConcerns: input.unresolvedConcerns ?? d.unresolvedConcerns,
      reasoning: input.reasoning ?? d.reasoning,
      latestDiscussedAt: new Date(),
      revisitCount: d.revisitCount + 1,
      updatedAt: new Date(),
    })
    .where(eq(decisionsTable.id, d.id));
  await db.insert(discussionsTable).values({
    decisionId: d.id,
    leaning: input.currentLeaning ?? d.currentLeaning,
    concerns: input.unresolvedConcerns ?? d.unresolvedConcerns,
    note: input.whatChanged ?? null,
  });
  const summary = `Updated crossroad "${d.title}" (revisit #${d.revisitCount + 1})`;
  await logActivity({ actionKind: "crossroad", summary, entityTable: "decisions", entityId: d.id, undoPayload: { op: "update", id: d.id, prev }, conversationId: input.conversationId });
  return { ok: true, summary };
}

/* ----------------------------- Observations ---------------------------- */

export async function recordObservation(input: {
  summary: string;
  detail?: string;
  roleName?: string;
  severity?: string;
  kind?: string;
  conversationId?: string | null;
}) {
  const role = input.roleName ? matchRole(input.roleName, await activeRoles()) : null;
  const [o] = await db
    .insert(insightsTable)
    .values({
      kind: input.kind ?? "observation",
      roleId: role?.id ?? null,
      summary: input.summary.slice(0, 300),
      detail: input.detail ?? null,
      severity: input.severity ?? "info",
      status: "open",
    })
    .returning();
  const summary = `Noted an observation: "${input.summary.slice(0, 80)}"`;
  await logActivity({ actionKind: "observation", summary, entityTable: "insights", entityId: o.id, undoPayload: { op: "create", id: o.id }, conversationId: input.conversationId });
  return { ok: true, summary };
}

export async function listObservations(query?: string, status = "open") {
  const rows = await db.select().from(insightsTable).orderBy(desc(insightsTable.createdAt));
  const q = query?.toLowerCase().trim();
  return rows
    .filter((o) => (status === "all" ? true : o.status === status))
    .filter((o) => !q || o.summary.toLowerCase().includes(q) || (o.detail ?? "").toLowerCase().includes(q))
    .map((o) => ({ summary: o.summary, detail: o.detail, severity: o.severity, status: o.status }));
}

/* ------------------------- Activity log (read) ------------------------- */

export async function listActivity(query?: string, limit = 20) {
  const rows = await db.select().from(activityTable).orderBy(desc(activityTable.createdAt)).limit(200);
  const q = query?.toLowerCase().trim();
  return rows
    .filter((a) => !q || a.summary.toLowerCase().includes(q) || a.actionKind.toLowerCase().includes(q))
    .slice(0, limit)
    .map((a) => ({ summary: a.summary, kind: a.actionKind, when: a.createdAt.toISOString(), undone: !!a.undoneAt }));
}

/* --------------------------- Check-ins (read) -------------------------- */

export async function listCheckins(limit = 10) {
  const rows = await db.select().from(checkinsTable).orderBy(desc(checkinsTable.checkinDate), desc(checkinsTable.createdAt)).limit(limit);
  return rows.map((c) => ({ date: c.checkinDate, energy: c.energyLevel, overwhelm: c.overwhelmLevel, notes: c.notes }));
}

/* --------------------- Attention history (dated read) ------------------ */

/**
 * Dated attention/activity history — ordered by when it actually HAPPENED
 * (occurredAt), not when it was entered. This is what answers "when did I last
 * work out?", "how consistent was I in May?", "frequency over time".
 */
export async function listAttentionHistory(opts?: {
  roleName?: string;
  type?: AttentionType;
  sinceDays?: number;
  limit?: number;
}) {
  const roles = await activeRoles();
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const role = opts?.roleName ? matchRole(opts.roleName, roles) : null;

  const rows = await db
    .select()
    .from(attentionTable)
    .orderBy(desc(attentionTable.occurredAt))
    .limit(500);

  const since = opts?.sinceDays != null ? Date.now() - opts.sinceDays * 24 * 60 * 60 * 1000 : null;
  return rows
    .filter((e) => !role || e.roleId === role.id)
    .filter((e) => !opts?.type || e.attentionType === opts.type)
    .filter((e) => since == null || e.occurredAt.getTime() >= since)
    .slice(0, opts?.limit ?? 50)
    .map((e) => ({
      date: formatDate(e.occurredAt),
      role: roleName.get(e.roleId) ?? null,
      type: e.attentionType,
      durationMinutes: e.durationMinutes,
      notes: e.notes,
      enteredOn: formatDate(e.createdAt),
    }));
}

/* ----------------------------- Ideas (more) ---------------------------- */

export async function listIdeas(query?: string, includeArchived = false) {
  const rows = await db.select().from(ideasTable).orderBy(desc(ideasTable.createdAt));
  const roles = await activeRoles();
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const q = query?.toLowerCase().trim();
  return rows
    .filter((i) => (includeArchived ? true : i.status !== "archived"))
    .filter((i) => !q || i.title.toLowerCase().includes(q) || (i.notes ?? "").toLowerCase().includes(q))
    .map((i) => ({ title: i.title, status: i.status, role: i.roleId ? roleName.get(i.roleId) ?? null : null }));
}

export async function manageIdea(input: {
  action: "update" | "archive";
  query: string;
  title?: string;
  status?: string;
  conversationId?: string | null;
}) {
  const matches = await findSimilarIdeas(input.query);
  const idea = matches[0]?.idea;
  if (!idea) return { ok: false, summary: "Couldn't find that idea." };

  if (input.action === "archive") {
    const prev = { status: idea.status };
    await db.update(ideasTable).set({ status: "archived", updatedAt: new Date() }).where(eq(ideasTable.id, idea.id));
    const summary = `Archived idea "${idea.title}"`;
    await logActivity({ actionKind: "idea_manage", summary, entityTable: "ideas", entityId: idea.id, undoPayload: { op: "archive", id: idea.id, prev }, conversationId: input.conversationId });
    return { ok: true, summary };
  }

  const prev = { title: idea.title, status: idea.status };
  await db
    .update(ideasTable)
    .set({ title: input.title ?? idea.title, status: (input.status ?? idea.status) as never, updatedAt: new Date() })
    .where(eq(ideasTable.id, idea.id));
  const summary = `Updated idea "${idea.title}"`;
  await logActivity({ actionKind: "idea_manage", summary, entityTable: "ideas", entityId: idea.id, undoPayload: { op: "update", id: idea.id, prev }, conversationId: input.conversationId });
  return { ok: true, summary };
}

/* -------------------------------- Undo --------------------------------- */

/* ------------------------------ Memories ------------------------------- */

const TIER_LABEL: Record<string, string> = {
  identity: "who she is",
  learned_pattern: "a pattern",
  temporary_context: "for now",
};

/**
 * Promote a statement to long-term memory. Operating Rules are NOT stored here —
 * they route to working_agreements (always-loaded, binding). identity /
 * learned_pattern / temporary_context land in the memories table.
 */
export async function promoteMemory(input: {
  type: MemoryType | "operating_rule";
  content: string;
  why?: string | null;
  confidence?: Confidence | null;
  evidence?: string | null;
  role?: Role | null;
  expiresAt?: Date | null;
  conversationId?: string | null;
}) {
  // Operating rules live with the working agreements (the binding tier).
  if (input.type === "operating_rule") {
    const res = await addWorkingAgreement({
      text: input.content,
      category: "behavior",
      conversationId: input.conversationId,
    });
    return { ...res, type: "operating_rule" as const };
  }

  const [row] = await db
    .insert(memoriesTable)
    .values({
      type: input.type,
      content: input.content.slice(0, 1000),
      whyItMatters: input.why ?? null,
      confidence: input.type === "learned_pattern" ? input.confidence ?? "medium" : null,
      evidence: input.evidence ?? null,
      roleId: input.role?.id ?? null,
      expiresAt: input.type === "temporary_context" ? input.expiresAt ?? null : null,
      source: "promotion",
    })
    .returning();

  const summary = `Remembered (${TIER_LABEL[input.type] ?? input.type}): "${input.content.slice(0, 80)}"`;
  await logActivity({
    actionKind: "memory_create",
    summary,
    entityTable: "memories",
    entityId: row.id,
    undoPayload: { id: row.id },
    conversationId: input.conversationId,
  });
  return { summary, type: input.type, id: row.id };
}

/** Read/search memories. Auto-expires stale temporary context as a side effect. */
export async function listMemories(opts?: { type?: MemoryType; query?: string; includeArchived?: boolean }) {
  const rows = await db.select().from(memoriesTable).orderBy(desc(memoriesTable.createdAt));
  const roles = await activeRoles();
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const now = Date.now();
  const q = opts?.query?.toLowerCase().trim();

  // Lazily archive expired temporary context so it stops loading into context.
  const expired = rows.filter(
    (m) => m.status === "active" && m.expiresAt && new Date(m.expiresAt).getTime() < now
  );
  for (const m of expired) {
    await db.update(memoriesTable).set({ status: "archived", updatedAt: new Date() }).where(eq(memoriesTable.id, m.id));
    m.status = "archived";
  }

  return rows
    .filter((m) => (opts?.includeArchived ? true : m.status === "active"))
    .filter((m) => !opts?.type || m.type === opts.type)
    .filter((m) => !q || m.content.toLowerCase().includes(q) || (m.evidence ?? "").toLowerCase().includes(q) || (m.whyItMatters ?? "").toLowerCase().includes(q))
    .map((m) => ({
      type: m.type,
      content: m.content,
      why: m.whyItMatters,
      confidence: m.confidence,
      evidence: m.evidence,
      role: m.roleId ? roleName.get(m.roleId) ?? null : null,
      expiresAt: m.expiresAt ? m.expiresAt.toISOString() : null,
      status: m.status,
    }));
}

/** Fuzzy-find one memory by text (for revise/remove). */
async function findMemory(query: string) {
  const rows = await db.select().from(memoriesTable).where(eq(memoriesTable.status, "active"));
  const q = query.toLowerCase().trim();
  return (
    rows.find((m) => m.content.toLowerCase() === q) ||
    rows.find((m) => m.content.toLowerCase().includes(q)) ||
    rows.find((m) => q.includes(m.content.toLowerCase().slice(0, 30))) ||
    null
  );
}

/** Revise (supersede) or remove (archive) a memory — learned patterns are revisable. */
export async function manageMemory(input: {
  action: "update" | "archive";
  query: string;
  content?: string;
  confidence?: Confidence | null;
  evidence?: string | null;
  conversationId?: string | null;
}) {
  const m = await findMemory(input.query);
  if (!m) return { ok: false, message: `Couldn't find a memory matching "${input.query}".` };

  const prev = { content: m.content, confidence: m.confidence, evidence: m.evidence, status: m.status };

  if (input.action === "archive") {
    await db.update(memoriesTable).set({ status: "archived", updatedAt: new Date() }).where(eq(memoriesTable.id, m.id));
  } else {
    const history = Array.isArray(m.changeHistory) ? (m.changeHistory as unknown[]) : [];
    await db
      .update(memoriesTable)
      .set({
        content: input.content?.slice(0, 1000) ?? m.content,
        confidence: input.confidence ?? m.confidence,
        evidence: input.evidence ?? m.evidence,
        changeHistory: [...history, { at: new Date().toISOString(), prev }] as never,
        updatedAt: new Date(),
      })
      .where(eq(memoriesTable.id, m.id));
  }

  const summary = input.action === "archive"
    ? `Forgot a memory: "${m.content.slice(0, 80)}"`
    : `Updated a memory: "${(input.content ?? m.content).slice(0, 80)}"`;
  await logActivity({
    actionKind: "memory_manage",
    summary,
    entityTable: "memories",
    entityId: m.id,
    undoPayload: { id: m.id, prev },
    conversationId: input.conversationId,
  });
  return { ok: true, message: summary };
}

/** Search the conversation archive (stored messages — not active memory). */
export async function searchConversations(query: string, limit = 12) {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(ilike(messagesTable.content, `%${query}%`))
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit);
  return rows.map((m) => ({
    who: m.role === "user" ? "Selena" : m.role === "chief_of_staff" ? "Scout" : "system",
    when: m.createdAt.toISOString(),
    text: m.content.slice(0, 240),
  }));
}

/* -------------------- Process memory / workflow state ------------------ */

/**
 * Long-running, multi-step processes (recalibration) must survive a chat
 * refresh. State lives in the DB, not the conversation. `state` is a free-form
 * progress object: rolesCompleted, rolesRemaining, summariesPerRole,
 * projectsIdentified, crossroadsIdentified, memoriesProposed, unresolvedQuestions.
 */
export async function getActiveWorkflow(kind?: string) {
  const rows = await db
    .select()
    .from(workflowStatesTable)
    .where(eq(workflowStatesTable.status, "active"))
    .orderBy(desc(workflowStatesTable.updatedAt));
  const row = kind ? rows.find((r) => r.kind === kind) : rows[0];
  if (!row) return null;
  return { id: row.id, kind: row.kind, status: row.status, state: row.state as Record<string, unknown>, startedAt: row.startedAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function startWorkflow(input: { kind: string; state?: Record<string, unknown>; conversationId?: string | null }) {
  // Resume an existing active run of the same kind rather than duplicating it.
  const existing = await getActiveWorkflow(input.kind);
  if (existing) return { ok: true, resumed: true, id: existing.id, state: existing.state };
  const [row] = await db
    .insert(workflowStatesTable)
    .values({ kind: input.kind, status: "active", state: (input.state ?? {}) as never })
    .returning();
  await logActivity({
    actionKind: "workflow_start",
    summary: `Started a ${input.kind} workflow`,
    entityTable: "workflow_states",
    entityId: row.id,
    undoPayload: { id: row.id },
    conversationId: input.conversationId,
  });
  return { ok: true, resumed: false, id: row.id, state: row.state };
}

export async function updateWorkflowState(input: { kind?: string; id?: string; patch: Record<string, unknown>; complete?: boolean; conversationId?: string | null }) {
  const current = input.id
    ? (await db.select().from(workflowStatesTable).where(eq(workflowStatesTable.id, input.id)))[0]
    : null;
  const active = current ?? (input.kind ? await db.select().from(workflowStatesTable).where(eq(workflowStatesTable.status, "active")).orderBy(desc(workflowStatesTable.updatedAt)).then((r) => r.find((x) => x.kind === input.kind)) : (await db.select().from(workflowStatesTable).where(eq(workflowStatesTable.status, "active")).orderBy(desc(workflowStatesTable.updatedAt)))[0]);
  if (!active) return { ok: false, message: "No active workflow to update — start one first." };

  const merged = { ...(active.state as Record<string, unknown>), ...input.patch };
  await db
    .update(workflowStatesTable)
    .set({ state: merged as never, status: input.complete ? "complete" : active.status, completedAt: input.complete ? new Date() : active.completedAt, updatedAt: new Date() })
    .where(eq(workflowStatesTable.id, active.id));
  await logActivity({
    actionKind: "workflow_update",
    summary: input.complete ? `Completed the ${active.kind} workflow` : `Updated ${active.kind} workflow progress`,
    entityTable: "workflow_states",
    entityId: active.id,
    conversationId: input.conversationId,
  });
  return { ok: true, id: active.id, state: merged, status: input.complete ? "complete" : active.status };
}

/* --------------------------- App settings (kv) ------------------------- */

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
}

export async function proofModeOn(): Promise<boolean> {
  return (await getSetting("proof_mode")) === "on";
}

/* ------------------------------ Reminders ------------------------------ */

export async function createReminder(input: {
  text: string;
  remindAt: Date;
  recurrence?: "daily" | "weekdays" | "weekly" | "monthly" | null;
  conversationId?: string | null;
}) {
  const [row] = await db
    .insert(remindersTable)
    .values({ text: input.text.slice(0, 1000), remindAt: input.remindAt, recurrence: input.recurrence ?? null, source: "chat" })
    .returning();
  const repeat = input.recurrence ? `, repeating ${input.recurrence}` : "";
  const summary = `Set a reminder for ${formatDate(input.remindAt)} ${formatTime(input.remindAt)}${repeat}: "${input.text.slice(0, 80)}"`;
  await logActivity({
    actionKind: "reminder_create",
    summary,
    entityTable: "reminders",
    entityId: row.id,
    undoPayload: { id: row.id },
    conversationId: input.conversationId,
  });
  return { ok: true, id: row.id, summary };
}

/** Upcoming pending reminders (soonest first). */
export async function listReminders(limit = 20) {
  const rows = await db
    .select()
    .from(remindersTable)
    .where(eq(remindersTable.status, "pending"))
    .orderBy(remindersTable.remindAt)
    .limit(limit);
  return rows.map((r) => ({ id: r.id, text: r.text, at: `${formatDate(r.remindAt)} ${formatTime(r.remindAt)}`, repeats: r.recurrence ?? null }));
}

/** After a recurring reminder fires, advance it to its next occurrence (stays pending). */
export async function rearmReminder(id: string, nextAt: Date) {
  await db.update(remindersTable).set({ remindAt: nextAt, sentAt: new Date() }).where(eq(remindersTable.id, id));
}

export async function cancelReminder(query: string, conversationId?: string | null) {
  const rows = await db.select().from(remindersTable).where(eq(remindersTable.status, "pending"));
  const q = query.toLowerCase().trim();
  const match =
    rows.find((r) => r.text.toLowerCase() === q) ||
    rows.find((r) => r.text.toLowerCase().includes(q)) ||
    rows.find((r) => q.includes(r.text.toLowerCase().slice(0, 20))) ||
    null;
  if (!match) return { ok: false, message: `No pending reminder matching "${query}".` };
  await db.update(remindersTable).set({ status: "canceled" }).where(eq(remindersTable.id, match.id));
  const summary = `Canceled reminder: "${match.text.slice(0, 80)}"`;
  await logActivity({ actionKind: "reminder_cancel", summary, entityTable: "reminders", entityId: match.id, undoPayload: { id: match.id }, conversationId });
  return { ok: true, message: summary };
}

/** Reminders due now (for the tick cron). */
export async function dueReminders() {
  return db
    .select()
    .from(remindersTable)
    .where(and(eq(remindersTable.status, "pending"), lte(remindersTable.remindAt, new Date())));
}

export async function markReminderSent(id: string) {
  await db.update(remindersTable).set({ status: "sent", sentAt: new Date() }).where(eq(remindersTable.id, id));
}

export async function undoLast(): Promise<{ ok: boolean; message: string }> {
  const [last] = await db
    .select()
    .from(activityTable)
    .where(isNull(activityTable.undoneAt))
    .orderBy(desc(activityTable.createdAt))
    .limit(1);
  if (!last) return { ok: false, message: "There's nothing to undo." };
  const result = await undoActivity(last.id);
  return result;
}

export async function undoActivity(id: string): Promise<{ ok: boolean; message: string }> {
  const [entry] = await db.select().from(activityTable).where(eq(activityTable.id, id)).limit(1);
  if (!entry) return { ok: false, message: "That action wasn't found." };
  if (entry.undoneAt) return { ok: false, message: "That was already undone." };
  const p = (entry.undoPayloadJson ?? {}) as Record<string, unknown> & {
    [k: string]: string | number | null | undefined | Record<string, unknown>;
  };

  try {
    switch (entry.actionKind) {
      case "log_attention":
        await db.delete(attentionTable).where(eq(attentionTable.id, p.eventId as string));
        break;
      case "create_task":
        if (p.todoistId) await deleteTodoistTask(p.todoistId as string).catch(() => {});
        await db.delete(tasksTable).where(eq(tasksTable.id, p.taskId as string));
        break;
      case "complete_task":
        if (p.todoistId) await reopenTodoistTask(p.todoistId as string).catch(() => {});
        await db
          .update(tasksTable)
          .set({ status: "open", completedAt: null, updatedAt: new Date() })
          .where(eq(tasksTable.id, p.taskId as string));
        break;
      case "complete_task_live":
        if (p.todoistId) await reopenTodoistTask(p.todoistId as string).catch(() => {});
        await db
          .update(tasksTable)
          .set({ status: "open", completedAt: null, updatedAt: new Date() })
          .where(eq(tasksTable.externalId, p.todoistId as string));
        break;
      case "create_idea":
        await db.delete(ideasTable).where(eq(ideasTable.id, p.ideaId as string));
        break;
      case "append_idea_note":
        await db
          .update(ideasTable)
          .set({ notes: (p.prevNotes as string) ?? null, updatedAt: new Date() })
          .where(eq(ideasTable.id, p.ideaId as string));
        break;
      case "reassign": {
        const isTask = p.entityTable === "tasks";
        const table = isTask ? tasksTable : ideasTable;
        const setObj: Record<string, unknown> = {
          roleId: (p.prevRoleId as string) ?? null,
          updatedAt: new Date(),
        };
        if (isTask) setObj.projectId = (p.prevProjectId as string) ?? null;
        await db.update(table).set(setObj as never).where(eq(table.id, p.entityId as string));
        break;
      }
      case "record_pushback":
        if (p.taskId != null && p.prevAvoidance != null) {
          await db
            .update(tasksTable)
            .set({ avoidanceCount: p.prevAvoidance as number, updatedAt: new Date() })
            .where(eq(tasksTable.id, p.taskId as string));
        }
        break;
      case "save_checkin":
        await db.delete(checkinsTable).where(eq(checkinsTable.id, p.checkinId as string));
        break;
      case "working_agreement":
        await db.delete(agreementsTable).where(eq(agreementsTable.id, p.agreementId as string));
        break;
      case "role": {
        const id = p.id as string;
        if (p.op === "create") await db.delete(rolesTable).where(eq(rolesTable.id, id));
        else if (p.op === "archive") await db.update(rolesTable).set({ archivedAt: null }).where(eq(rolesTable.id, id));
        else if (p.op === "update") {
          const prev = p.prev as { name: string; importanceLevel: string; currentStatus: string; changeHistory?: unknown; description?: string | null; mission?: string | null; desiredState?: string | null; warningSigns?: string | null; maintenanceMinimum?: string | null };
          await db.update(rolesTable).set({ name: prev.name, importanceLevel: prev.importanceLevel as never, currentStatus: prev.currentStatus as never, changeHistory: (prev.changeHistory ?? null) as never, description: prev.description ?? null, mission: prev.mission ?? null, desiredState: prev.desiredState ?? null, warningSigns: prev.warningSigns ?? null, maintenanceMinimum: prev.maintenanceMinimum ?? null }).where(eq(rolesTable.id, id));
        }
        break;
      }
      case "project": {
        const id = p.id as string;
        if (p.op === "create") await db.delete(projectsTable).where(eq(projectsTable.id, id));
        else if (p.op === "archive") {
          const prev = p.prev as { status: string };
          await db.update(projectsTable).set({ status: (prev?.status ?? "active") as never }).where(eq(projectsTable.id, id));
        } else if (p.op === "update") {
          const prev = p.prev as { name: string; roleId: string | null; status: string; description?: string | null; desiredOutcome?: string | null };
          await db.update(projectsTable).set({ name: prev.name, roleId: prev.roleId, status: prev.status as never, description: prev.description ?? null, desiredOutcome: prev.desiredOutcome ?? null }).where(eq(projectsTable.id, id));
        }
        break;
      }
      case "crossroad": {
        const id = p.id as string;
        if (p.op === "create") await db.delete(decisionsTable).where(eq(decisionsTable.id, id));
        else if (p.op === "archive") {
          const prev = p.prev as { status: string };
          await db.update(decisionsTable).set({ status: (prev?.status ?? "open") as never }).where(eq(decisionsTable.id, id));
        } else if (p.op === "update") {
          const prev = p.prev as Record<string, unknown>;
          await db.update(decisionsTable).set({ ...prev } as never).where(eq(decisionsTable.id, id));
        }
        break;
      }
      case "observation":
        await db.delete(insightsTable).where(eq(insightsTable.id, p.id as string));
        break;
      case "memory_create":
        await db.delete(memoriesTable).where(eq(memoriesTable.id, p.id as string));
        break;
      case "reminder_create":
        await db.delete(remindersTable).where(eq(remindersTable.id, p.id as string));
        break;
      case "reminder_cancel":
        await db.update(remindersTable).set({ status: "pending" }).where(eq(remindersTable.id, p.id as string));
        break;
      case "workflow_start":
        await db.delete(workflowStatesTable).where(eq(workflowStatesTable.id, p.id as string));
        break;
      case "memory_manage": {
        const prev = p.prev as { content: string; confidence: string | null; evidence: string | null; status: string };
        await db
          .update(memoriesTable)
          .set({ content: prev.content, confidence: prev.confidence as never, evidence: prev.evidence, status: prev.status as never, updatedAt: new Date() })
          .where(eq(memoriesTable.id, p.id as string));
        break;
      }
      case "idea_manage": {
        const id = p.id as string;
        const prev = p.prev as { title?: string; status: string };
        await db
          .update(ideasTable)
          .set({ title: prev.title ?? undefined, status: prev.status as never } as never)
          .where(eq(ideasTable.id, id));
        break;
      }
      default:
        return { ok: false, message: `"${entry.summary}" can't be undone automatically.` };
    }
  } catch {
    return { ok: false, message: `Couldn't fully undo "${entry.summary}".` };
  }

  await db.update(activityTable).set({ undoneAt: new Date() }).where(eq(activityTable.id, entry.id));
  return { ok: true, message: `Undone: ${entry.summary}` };
}
