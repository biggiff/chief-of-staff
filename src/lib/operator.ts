import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  checkins as checkinsTable,
  checkinRoleScores as checkinRoleScoresTable,
  roleAttentionEvents as attentionTable,
  activityLog as activityTable,
  type AttentionType,
  type Priority,
  type Role,
} from "@/db";
import {
  createTodoistTask,
  closeTodoistTask,
  reopenTodoistTask,
  deleteTodoistTask,
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
  conversationId?: string | null;
}) {
  const [event] = await db
    .insert(attentionTable)
    .values({
      roleId: input.role.id,
      projectId: input.projectId ?? null,
      attentionType: input.attentionType,
      durationMinutes: input.durationMinutes ?? null,
      notes: input.notes ?? null,
      source: "chat",
    })
    .returning();
  await db
    .update(rolesTable)
    .set({ lastMeaningfulAttentionAt: new Date(), updatedAt: new Date() })
    .where(eq(rolesTable.id, input.role.id));

  const dur = input.durationMinutes ? ` (${input.durationMinutes} min)` : "";
  const summary = `Logged ${input.attentionType.replace("_", " ")} attention to ${input.role.name}${dur}`;
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
  return { checkin, summary };
}

/* -------------------------------- Undo --------------------------------- */

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
  const p = (entry.undoPayloadJson ?? {}) as Record<string, string | number | null>;

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
      default:
        return { ok: false, message: `"${entry.summary}" can't be undone automatically.` };
    }
  } catch {
    return { ok: false, message: `Couldn't fully undo "${entry.summary}".` };
  }

  await db.update(activityTable).set({ undoneAt: new Date() }).where(eq(activityTable.id, entry.id));
  return { ok: true, message: `Undone: ${entry.summary}` };
}
