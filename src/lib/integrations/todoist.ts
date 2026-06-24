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
  sectionId?: string | null;
}): Promise<CreatedTodoistTask> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const body: Record<string, unknown> = { content: input.content };
  if (input.priority) body.priority = writePriority(input.priority);
  if (input.dueString) body.due_string = input.dueString;
  if (input.projectId) body.project_id = input.projectId;
  if (input.sectionId) body.section_id = input.sectionId;
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

/** Map a Todoist project id to its name (for read-back). Null/unknown → "Inbox". */
export async function todoistProjectNameById(id: string | null | undefined): Promise<string> {
  if (!id) return "Inbox";
  const token = todoistToken();
  if (!token) return "Inbox";
  const projects = await paginate<TodoistProject>(token, "projects");
  return projects.find((p) => p.id === id)?.name ?? "Inbox";
}

/** Active (non-deleted) project names — so Scout can confirm a real target instead of inventing one. */
export async function listTodoistProjects(): Promise<string[]> {
  const token = todoistToken();
  if (!token) return [];
  const projects = await paginate<TodoistProject>(token, "projects");
  return projects.filter((p) => !p.is_deleted).map((p) => p.name);
}

/** Move a task to a different PROJECT, then READ BACK its real project id to
 *  confirm it actually landed (returns the post-move project id, or null). */
export async function moveTodoistTaskToProject(id: string, projectId: string): Promise<string | null> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const res = await fetch(`${API}/tasks/${id}/move`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: projectId }),
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist move ${res.status}: ${t.slice(0, 200)}`);
  }
  const check = await fetch(`${API}/tasks/${id}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!check.ok) return null;
  return ((await check.json()) as TodoistTask).project_id ?? null;
}

/** Move an existing task into a section (used to re-categorize a grocery item). */
export async function moveTodoistTask(id: string, sectionId: string): Promise<void> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const res = await fetch(`${API}/tasks/${id}/move`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ section_id: sectionId }),
  });
  if (!res.ok && res.status !== 204) {
    const t = await res.text().catch(() => "");
    throw new Error(`Todoist move ${res.status}: ${t.slice(0, 200)}`);
  }
}

async function findOrCreateProject(token: string, name: string): Promise<string> {
  const projects = await paginate<TodoistProject>(token, "projects");
  const existing = projects.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing) return existing.id;
  const res = await fetch(`${API}/projects`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Todoist project create ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return ((await res.json()) as TodoistProject).id;
}

async function findOrCreateSection(token: string, projectId: string, name: string, existing: TodoistSection[]): Promise<string> {
  const match = existing.find((s) => s.project_id === projectId && s.name.toLowerCase() === name.toLowerCase());
  if (match) return match.id;
  const res = await fetch(`${API}/sections`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, project_id: projectId }),
  });
  if (!res.ok) throw new Error(`Todoist section create ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return ((await res.json()) as TodoistSection).id;
}

/**
 * Resolve an EXISTING project by id or name and return its real sections — no
 * creation. Used so groceries write into the user's own list with the user's own
 * sections, rather than a parallel project Scout made up.
 */
export async function resolveProjectAndSections(
  idOrName: string
): Promise<{ projectId: string; name: string; sectionsByName: Record<string, string>; sectionNames: string[] } | null> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const projects = await paginate<TodoistProject>(token, "projects");
  const proj =
    projects.find((p) => p.id === idOrName) ||
    projects.find((p) => p.name.toLowerCase() === idOrName.toLowerCase()) ||
    projects.find((p) => p.name.toLowerCase().includes(idOrName.toLowerCase()));
  if (!proj) return null;
  const allSections = await paginate<TodoistSection>(token, "sections");
  const mine = allSections.filter((s) => s.project_id === proj.id && !s.is_deleted);
  const sectionsByName: Record<string, string> = {};
  for (const s of mine) sectionsByName[s.name] = s.id;
  return { projectId: proj.id, name: proj.name, sectionsByName, sectionNames: mine.map((s) => s.name) };
}

/** Delete a Todoist project (and its tasks). Used to remove the duplicate Scout made. */
export async function deleteTodoistProject(projectId: string): Promise<void> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const res = await fetch(`${API}/projects/${projectId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) throw new Error(`Todoist project delete ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Ensure a project exists with the given sections (creates what's missing).
 * Returns the project id and a name→sectionId map. Used for the Grocery setup.
 */
export async function ensureProjectWithSections(
  projectName: string,
  sectionNames: string[]
): Promise<{ projectId: string; sections: Record<string, string> }> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const projectId = await findOrCreateProject(token, projectName);
  const allSections = await paginate<TodoistSection>(token, "sections");
  const sections: Record<string, string> = {};
  for (const name of sectionNames) {
    sections[name] = await findOrCreateSection(token, projectId, name, allSections);
  }
  return { projectId, sections };
}

/** All open tasks in a project — fetched ONCE (callers dedupe in-memory). */
export async function listActiveTasksInProject(projectId: string): Promise<{ id: string; content: string }[]> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const tasks = await fetchActiveTasks(token);
  return tasks.filter((t) => t.project_id === projectId).map((t) => ({ id: t.id, content: t.content }));
}

/**
 * Fuzzy-find an open task across ALL projects, LIVE from Todoist — bypasses the
 * (possibly stale) Compass mirror. Used as the completion fallback so grocery and
 * recently-added items can always be closed.
 */
export async function findActiveTodoistTask(query: string): Promise<{
  best: { id: string; content: string } | null;
  confident: boolean;
  candidates: { id: string; content: string }[];
}> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");
  const tasks = await fetchActiveTasks(token);
  const q = query.toLowerCase().trim();
  const qWords = q.split(/\W+/).filter(Boolean);
  const scored = tasks
    .map((t) => {
      const title = t.content.toLowerCase();
      let score = 0;
      if (title === q) score = 100;
      else if (title.includes(q) || q.includes(title)) score = 80;
      else {
        const tw = new Set(title.split(/\W+/).filter(Boolean));
        const overlap = qWords.filter((w) => tw.has(w)).length;
        score = (overlap / Math.max(qWords.length, 1)) * 60;
      }
      return { id: t.id, content: t.content, score };
    })
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1];
  const confident = !!best && best.score >= 50 && (!second || best.score - second.score >= 15);
  return {
    best: best && best.score >= 30 ? { id: best.id, content: best.content } : null,
    confident,
    candidates: scored.filter((s) => s.score >= 30).slice(0, 5).map((s) => ({ id: s.id, content: s.content })),
  };
}

/** Find an open task by name within a project (single lookup — re-fetches the list). */
export async function findTaskInProject(projectId: string, query: string): Promise<{ id: string; content: string } | null> {
  const inProj = await listActiveTasksInProject(projectId);
  const q = query.toLowerCase().trim();
  return (
    inProj.find((t) => t.content.toLowerCase() === q) ||
    inProj.find((t) => t.content.toLowerCase().includes(q)) ||
    inProj.find((t) => q.includes(t.content.toLowerCase())) ||
    null
  );
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

/**
 * Sync only if the mirror is stale (default: older than 10 min), so the Compass
 * task mirror stays current without re-fetching Todoist on every interaction.
 */
export async function syncTodoistIfStale(maxAgeMinutes = 10): Promise<void> {
  if (!todoistEnabled()) return;
  const [row] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.provider, PROVIDER))
    .limit(1);
  const last = row?.lastSyncAt ? new Date(row.lastSyncAt).getTime() : 0;
  if (Date.now() - last < maxAgeMinutes * 60 * 1000) return;
  try {
    await syncTodoist();
  } catch (err) {
    console.error("auto-sync failed", err);
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
