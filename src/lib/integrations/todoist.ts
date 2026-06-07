import { and, eq } from "drizzle-orm";
import { db, tasks as tasksTable, integrations as integrationsTable, type Priority } from "@/db";

/**
 * Todoist integration (REST API v2).
 *
 * Auth is a single personal API token (TODOIST_API_TOKEN) — no OAuth dance,
 * since this is a single-user app. Sync is idempotent: each Todoist task maps
 * to one row in our `tasks` table keyed by (source="todoist", external_id).
 * Imported tasks have no role yet; you (or the AI) assign one later.
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
  checked?: boolean;
  is_deleted?: boolean;
};

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

// Todoist API v1: GET /tasks returns { results, next_cursor } and is paginated.
async function fetchActiveTasks(token: string): Promise<TodoistTask[]> {
  const all: TodoistTask[] = [];
  let cursor: string | null = null;
  do {
    const url = new URL(`${API}/tasks`);
    url.searchParams.set("limit", "200");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Todoist API ${res.status}: ${body.slice(0, 200)}`);
    }
    const page = (await res.json()) as { results: TodoistTask[]; next_cursor: string | null };
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  // Active = not completed and not deleted.
  return all.filter((t) => !t.checked && !t.is_deleted);
}

export type TodoistSyncResult = {
  imported: number;
  updated: number;
  closed: number;
  total: number;
};

/** Pull active Todoist tasks into our DB, idempotently. */
export async function syncTodoist(): Promise<TodoistSyncResult> {
  const token = todoistToken();
  if (!token) throw new Error("TODOIST_API_TOKEN is not set.");

  let result: TodoistSyncResult = { imported: 0, updated: 0, closed: 0, total: 0 };
  try {
    const remote = await fetchActiveTasks(token);
    result.total = remote.length;

    // Existing todoist-sourced rows, keyed by external id.
    const existing = await db
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.source, "todoist"));
    const byExternal = new Map(existing.map((t) => [t.externalId, t]));
    const remoteIds = new Set(remote.map((t) => t.id));

    for (const t of remote) {
      const prior = byExternal.get(t.id);
      const values = {
        title: t.content.slice(0, 200),
        notes: t.description || null,
        priority: mapPriority(t.priority),
        dueDate: dueToDate(t),
        status: "open" as const,
        source: "todoist",
        externalId: t.id,
        updatedAt: new Date(),
      };
      if (prior) {
        await db.update(tasksTable).set(values).where(eq(tasksTable.id, prior.id));
        result.updated++;
      } else {
        await db.insert(tasksTable).values(values);
        result.imported++;
      }
    }

    // Tasks we imported before that are no longer active in Todoist → complete them.
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

/** Live read for the AI tool — current active Todoist tasks (no DB writes). */
export async function listTodoistTasks(limit = 25): Promise<
  { title: string; priority: Priority; due: string | null }[]
> {
  const token = todoistToken();
  if (!token) return [];
  const remote = await fetchActiveTasks(token);
  return remote.slice(0, limit).map((t) => ({
    title: t.content,
    priority: mapPriority(t.priority),
    due: t.due?.date ?? null,
  }));
}
