import { eq } from "drizzle-orm";
import {
  db,
  tasks as tasksTable,
  projects as projectsTable,
  integrations as integrationsTable,
  type Priority,
} from "@/db";

/**
 * Todoist integration (API v1).
 *
 * Auth is a single personal API token (TODOIST_API_TOKEN) — no OAuth dance,
 * since this is a single-user app. Sync is idempotent and *structure-preserving*:
 *   - Todoist projects  -> our `projects` rows (keyed by source="todoist", external_id)
 *   - Todoist sections  -> annotated onto the task's notes
 *   - Todoist tasks     -> our `tasks` rows linked to the mapped project
 * Imported projects/tasks have no role yet; you (or the AI) assign one later.
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
  projectsImported: number;
  imported: number;
  updated: number;
  closed: number;
  total: number;
};

/** Pull Todoist projects + tasks into our DB, idempotently and structure-preserving. */
export async function syncTodoist(): Promise<TodoistSyncResult> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");

  const result: TodoistSyncResult = {
    projectsImported: 0,
    imported: 0,
    updated: 0,
    closed: 0,
    total: 0,
  };

  try {
    const [remoteProjects, remoteSections, remoteTasks] = await Promise.all([
      paginate<TodoistProject>(token, "projects"),
      paginate<TodoistSection>(token, "sections"),
      fetchActiveTasks(token),
    ]);

    // --- Projects: upsert, build todoist project id -> our project id map ---
    const existingProjects = await db
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.source, "todoist"));
    const projByExternal = new Map(existingProjects.map((p) => [p.externalId, p]));
    const remoteProjectIds = new Set(remoteProjects.map((p) => p.id));
    const projectIdMap = new Map<string, string>(); // todoist id -> our id

    for (const p of remoteProjects) {
      if (p.is_deleted) continue;
      const prior = projByExternal.get(p.id);
      if (prior) {
        await db
          .update(projectsTable)
          .set({ name: p.name.slice(0, 200), status: "active", updatedAt: new Date() })
          .where(eq(projectsTable.id, prior.id));
        projectIdMap.set(p.id, prior.id);
      } else {
        const [created] = await db
          .insert(projectsTable)
          .values({ name: p.name.slice(0, 200), status: "active", source: "todoist", externalId: p.id })
          .returning();
        projectIdMap.set(p.id, created.id);
        result.projectsImported++;
      }
    }
    // Projects removed in Todoist → archive ours.
    for (const ep of existingProjects) {
      if (ep.externalId && !remoteProjectIds.has(ep.externalId) && ep.status !== "archived") {
        await db
          .update(projectsTable)
          .set({ status: "archived", updatedAt: new Date() })
          .where(eq(projectsTable.id, ep.id));
      }
    }

    const sectionName = new Map(remoteSections.map((s) => [s.id, s.name]));

    // --- Tasks: upsert, linked to mapped project, section noted ---
    result.total = remoteTasks.length;
    const existingTasks = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.source, "todoist"));
    const taskByExternal = new Map(existingTasks.map((t) => [t.externalId, t]));
    const remoteTaskIds = new Set(remoteTasks.map((t) => t.id));

    for (const t of remoteTasks) {
      const ourProjectId = t.project_id ? projectIdMap.get(t.project_id) ?? null : null;
      const section = t.section_id ? sectionName.get(t.section_id) : null;
      const notes =
        [section ? `Section: ${section}` : null, t.description || null]
          .filter(Boolean)
          .join("\n") || null;

      const values = {
        title: t.content.slice(0, 200),
        notes,
        priority: mapPriority(t.priority),
        dueDate: dueToDate(t),
        status: "open" as const,
        projectId: ourProjectId,
        source: "todoist",
        externalId: t.id,
        updatedAt: new Date(),
      };
      const prior = taskByExternal.get(t.id);
      if (prior) {
        await db.update(tasksTable).set(values).where(eq(tasksTable.id, prior.id));
        result.updated++;
      } else {
        await db.insert(tasksTable).values(values);
        result.imported++;
      }
    }

    // Tasks removed/completed in Todoist → complete ours.
    for (const e of existingTasks) {
      if (e.status === "open" && e.externalId && !remoteTaskIds.has(e.externalId)) {
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
export async function listTodoistTasks(limit = 40): Promise<
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
