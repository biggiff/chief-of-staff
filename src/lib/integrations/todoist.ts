import { eq } from "drizzle-orm";
import {
  db,
  tasks as tasksTable,
  projects as projectsTable,
  integrations as integrationsTable,
  todoistProjectLinks as linksTable,
  type Priority,
} from "@/db";

/**
 * Todoist integration (API v1) — Todoist is the source of truth for tasks.
 *
 * Our `tasks` table is a *mirror* keyed by Todoist id (external_id). The CoS
 * reads/creates/updates/completes tasks in Todoist; it does not become a
 * separate task manager.
 *
 * Todoist projects do NOT auto-create CoS projects. Instead `todoist_project_links`
 * maps a Todoist project -> a CoS role/project. Until a mapping exists, a mirrored
 * task carries its raw todoist_project_id (and keeps its list/section in notes for
 * context) but has no role/project. The CoS suggests mappings in conversation.
 */

const PROVIDER = "Todoist";
const API = "https://api.todoist.com/api/v1";

export function todoistToken(): string | null {
  return process.env.TODOIST_API_TOKEN || null;
}

export function todoistEnabled(): boolean {
  return !!todoistToken();
}

type TodoistTask = {
  id: string;
  content: string;
  description?: string;
  priority: number; // 1 (normal) … 4 (urgent)
  due?: { date?: string; datetime?: string } | null;
  project_id?: string | null;
  section_id?: string | null;
  parent_id?: string | null;
  checked?: boolean;
  is_deleted?: boolean;
};

type TodoistProject = { id: string; name: string; is_deleted?: boolean };
type TodoistSection = { id: string; name: string; project_id?: string; is_deleted?: boolean };

// Todoist priority 4 (urgent) → high; 3 → high; 2 → medium; 1 → low.
function mapPriority(p: number): Priority {
  if (p >= 3) return "high";
  if (p === 2) return "medium";
  return "low";
}

// Our priority → Todoist API priority (4 = highest).
function writePriority(p: Priority): number {
  return p === "high" ? 4 : p === "medium" ? 3 : 1;
}

export type CreatedTodoistTask = {
  id: string;
  content: string;
  project_id?: string | null;
  priority: number;
  due?: { date?: string; datetime?: string } | null;
};

/** Create a task in Todoist (source of truth). Returns the created task. */
export async function createTodoistTask(input: {
  content: string;
  priority?: Priority;
  dueString?: string | null;
  projectId?: string | null;
}): Promise<CreatedTodoistTask> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const body: Record<string, unknown> = { content: input.content };
  if (input.priority) body.priority = writePriority(input.priority);
  if (input.dueString) body.due_string = input.dueString;
  if (input.projectId) body.project_id = input.projectId;
  const res = await fetch(`${API}/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist create ${res.status}: ${t.slice(0, 200)}`);
  }
  return (await res.json()) as CreatedTodoistTask;
}

async function taskAction(id: string, action: "close" | "reopen"): Promise<void> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const res = await fetch(`${API}/tasks/${id}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist ${action} ${res.status}: ${t.slice(0, 200)}`);
  }
}

export const closeTodoistTask = (id: string) => taskAction(id, "close");
export const reopenTodoistTask = (id: string) => taskAction(id, "reopen");

export async function deleteTodoistTask(id: string): Promise<void> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const res = await fetch(`${API}/tasks/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist delete ${res.status}: ${t.slice(0, 200)}`);
  }
}

function dueToDate(t: TodoistTask): Date | null {
  const raw = t.due?.datetime || t.due?.date;
  return raw ? new Date(raw) : null;
}

// API v1 list endpoints return { results, next_cursor } and are paginated.
async function paginate<T>(token: string, path: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${API}/${path}`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Todoist API ${res.status} on ${path}: ${body.slice(0, 200)}`);
    }
    const page = (await res.json()) as { results: T[]; next_cursor: string | null };
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);
  return all;
}

async function fetchActiveTasks(token: string): Promise<TodoistTask[]> {
  const all = await paginate<TodoistTask>(token, "tasks");
  return all.filter((t) => !t.checked && !t.is_deleted);
}

export type TodoistSyncResult = {
  imported: number;
  updated: number;
  closed: number;
  linkedToRole: number;
  total: number;
};

/** Mirror active Todoist tasks into our DB. Idempotent, mapping-aware. */
export async function syncTodoist(): Promise<TodoistSyncResult> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");

  const result: TodoistSyncResult = { imported: 0, updated: 0, closed: 0, linkedToRole: 0, total: 0 };

  try {
    const [projects, sections, remoteTasks] = await Promise.all([
      paginate<TodoistProject>(token, "projects"),
      paginate<TodoistSection>(token, "sections"),
      fetchActiveTasks(token),
    ]);
    const projName = new Map(projects.map((p) => [p.id, p.name]));
    const secName = new Map(sections.map((s) => [s.id, s.name]));

    // Mapping layer: todoist project id -> CoS role/project (may be empty).
    const links = await db.select().from(linksTable);
    const linkMap = new Map(links.map((l) => [l.todoistProjectId, l]));

    // Cleanup: remove CoS projects auto-created by the previous (reverted)
    // approach. Going forward, CoS projects are curated, not imported.
    // Tasks referencing them get project_id nulled via the FK (on delete set null).
    await db.delete(projectsTable).where(eq(projectsTable.source, "todoist"));

    result.total = remoteTasks.length;
    const existing = await db.select().from(tasksTable).where(eq(tasksTable.source, "todoist"));
    const byExternal = new Map(existing.map((t) => [t.externalId, t]));
    const remoteIds = new Set(remoteTasks.map((t) => t.id));

    for (const t of remoteTasks) {
      const listName = t.project_id ? projName.get(t.project_id) ?? null : null;
      const section = t.section_id ? secName.get(t.section_id) : null;
      const link = t.project_id ? linkMap.get(t.project_id) : undefined;
      if (link?.roleId) result.linkedToRole++;

      const notes =
        [
          listName ? `List: ${listName}` : null,
          section ? `Section: ${section}` : null,
          t.description || null,
        ]
          .filter(Boolean)
          .join("\n") || null;

      const base = {
        title: t.content.slice(0, 200),
        notes,
        priority: mapPriority(t.priority),
        dueDate: dueToDate(t),
        status: "open" as const,
        source: "todoist",
        externalId: t.id,
        todoistProjectId: t.project_id ?? null,
        updatedAt: new Date(),
      };

      const prior = byExternal.get(t.id);
      if (prior) {
        // Preserve any manual role/project assignment unless a link dictates one.
        const upd = link
          ? { ...base, roleId: link.roleId, projectId: link.projectId }
          : base;
        await db.update(tasksTable).set(upd).where(eq(tasksTable.id, prior.id));
        result.updated++;
      } else {
        await db.insert(tasksTable).values({
          ...base,
          roleId: link?.roleId ?? null,
          projectId: link?.projectId ?? null,
        });
        result.imported++;
      }
    }

    // Tasks removed/completed in Todoist → complete ours.
    for (const e of existing) {
      if (e.status === "open" && e.externalId && !remoteIds.has(e.externalId)) {
        await db
          .update(tasksTable)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(tasksTable.id, e.id));
        result.closed++;
      }
    }

    await upsertStatus("connected", new Date(), null);
    return result;
  } catch (err) {
    await upsertStatus("error", null, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function upsertStatus(
  status: "connected" | "error" | "not_connected",
  lastSyncAt: Date | null,
  errorMessage: string | null
) {
  const [row] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.provider, PROVIDER))
    .limit(1);
  const settings = { ...(row?.settingsJson as object | null), lastError: errorMessage };
  if (row) {
    await db
      .update(integrationsTable)
      .set({
        status,
        lastSyncAt: lastSyncAt ?? row.lastSyncAt,
        settingsJson: settings,
        updatedAt: new Date(),
      })
      .where(eq(integrationsTable.id, row.id));
  } else {
    await db
      .insert(integrationsTable)
      .values({ provider: PROVIDER, status, lastSyncAt, settingsJson: settings });
  }
}

/** Live read for the AI tool — active Todoist tasks grouped by project (no DB writes). */
export async function listTodoistTasks(limit = 300): Promise<
  { title: string; project: string | null; section: string | null; priority: Priority; due: string | null }[]
> {
  const token = todoistToken();
  if (!token) return [];
  const [projects, sections, tasks] = await Promise.all([
    paginate<TodoistProject>(token, "projects"),
    paginate<TodoistSection>(token, "sections"),
    fetchActiveTasks(token),
  ]);
  const projName = new Map(projects.map((p) => [p.id, p.name]));
  const secName = new Map(sections.map((s) => [s.id, s.name]));
  return tasks.slice(0, limit).map((t) => ({
    title: t.content,
    project: t.project_id ? projName.get(t.project_id) ?? null : null,
    section: t.section_id ? secName.get(t.section_id) ?? null : null,
    priority: mapPriority(t.priority),
    due: t.due?.date ?? null,
  }));
}
