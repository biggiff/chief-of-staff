import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, desc } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  type Role,
} from "@/db";
import {
  scoreRoles,
  getLatestBriefing,
  getOrCreateTodaysBriefing,
  generateBriefing,
  briefingToText,
} from "./briefing";
import { formatDate } from "./dates";
import type { ChiefResponse } from "./chat-engine";

/**
 * Real AI layer for the Chief of Staff.
 *
 * The rule-based scoring engine remains the auditable backbone: the model is
 * given the *current structured state* (roles, attention scores, latest
 * briefing) in its system prompt, and all state-changing actions go through
 * deterministic tools (create task/idea, generate briefing, record pushback) —
 * never free-form. The model's job is interpretation and conversation, not
 * inventing facts.
 *
 * Falls back to the rule-based engine when no ANTHROPIC_API_KEY is configured.
 */

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Opus 4.8 is the default per Anthropic guidance. Override with COS_AI_MODEL
// (e.g. "claude-sonnet-4-6" or "claude-haiku-4-5") for lower cost/latency.
const MODEL = process.env.COS_AI_MODEL || "claude-opus-4-8";

const SYSTEM_PROMPT = `You are the user's personal Chief of Staff. You help them manage multiple life roles, decide where their attention should go, reduce decision fatigue, and notice avoidance patterns.

Voice and behavior:
- Direct, concise, useful. No fluffy encouragement, no generic productivity advice.
- Interpret role *health* — don't just repeat task lists.
- Distinguish urgency from strategic importance. Surface neglected roles, not just overdue tasks.
- A role can be operationally fine but relationally or strategically neglected — say so.
- Recommend ONE next 15-minute action when the user needs direction.
- When you recommend something, make it auditable: cite the reasoning from the briefing/scores.
- When the user pushes back on a role ("I don't want to work on X"), acknowledge it, offer a lower-friction alternative, but keep the role flagged and record the avoidance via the tool. Don't let them fully off the hook.
- If the user is overwhelmed, shrink the day to one thing.
- Keep replies short — a few sentences or tight bullets. This is a text-message interface.

Tools — use them, never fabricate:
- Use get_or_generate_briefing for "what's on tap today?" / what to focus on.
- Use create_task / create_idea to capture things the user wants saved.
- Use record_role_pushback when the user resists a role, so the avoidance is tracked.
You already receive the current structured state below; rely on it instead of guessing. Only the listed roles exist — match role names to that list.`;

async function activeRoles(): Promise<Role[]> {
  return db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));
}

function matchRole(name: string | undefined, roles: Role[]): Role | null {
  if (!name) return null;
  const lower = name.toLowerCase().trim();
  return (
    roles.find((r) => r.name.toLowerCase() === lower) ||
    roles.find((r) => r.name.toLowerCase().includes(lower)) ||
    roles.find((r) => lower.includes(r.name.toLowerCase())) ||
    null
  );
}

/** Snapshot of current state for the system prompt — the structured memory. */
async function buildContext(): Promise<string> {
  const scored = await scoreRoles();
  const briefing = await getLatestBriefing();

  const lines: string[] = [];
  lines.push("CURRENT STATE (computed by the rule-based engine):");
  lines.push("");
  lines.push("Roles, ranked by attention score (higher = needs attention more):");
  for (const s of scored) {
    const bits = [
      `status=${s.role.currentStatus}`,
      `importance=${s.role.importanceLevel}`,
      `score=${s.score}`,
      `open_tasks=${s.openTaskCount}`,
    ];
    if (s.overdueHighPriorityCount > 0) bits.push(`overdue_high=${s.overdueHighPriorityCount}`);
    if (s.stalledProjectCount > 0) bits.push(`stalled_projects=${s.stalledProjectCount}`);
    if (s.latestHealthScore != null) bits.push(`self_rated_health=${s.latestHealthScore}/10`);
    if (s.daysSinceAttention != null) bits.push(`days_since_attention=${s.daysSinceAttention}`);
    if (s.maxAvoidanceCount >= 2) bits.push(`avoided_task="${s.topAvoidedTaskTitle}"x${s.maxAvoidanceCount}`);
    lines.push(`- ${s.role.name}: ${bits.join(", ")}`);
    if (s.reasons.length) {
      lines.push(`    reasons: ${s.reasons.map((r) => `${r.label} (+${r.points})`).join("; ")}`);
    }
  }

  // Unassigned open tasks (e.g. freshly synced from Todoist, no role yet).
  const unassigned = await db
    .select()
    .from(tasksTable)
    .where(and(isNull(tasksTable.roleId), eq(tasksTable.status, "open")));
  if (unassigned.length) {
    lines.push("");
    lines.push(`Unassigned open tasks (${unassigned.length}) — not yet tied to a role:`);
    for (const t of unassigned.slice(0, 12)) {
      const src = t.source ? ` [${t.source}]` : "";
      const due = t.dueDate ? ` (due ${formatDate(t.dueDate)})` : "";
      lines.push(`- ${t.title}${due} priority=${t.priority}${src}`);
    }
    lines.push("If the user implies which role one belongs to, you can re-file it with create_task or suggest a role.");
  }

  // Today's calendar — real time pressure for the briefing.
  try {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import(
      "./integrations/google-calendar"
    );
    if (calendarEnabled()) {
      const events = await listTodaysEvents();
      lines.push("");
      lines.push(`Today's calendar (${events.length} event${events.length === 1 ? "" : "s"}):`);
      lines.push(formatEvents(events));
    }
  } catch (err) {
    console.error("calendar context failed:", err);
  }

  if (briefing) {
    lines.push("");
    lines.push(`Latest briefing (${formatDate(briefing.briefingDate)}):`);
    if (briefing.summary) lines.push(`  summary: ${briefing.summary}`);
    if (briefing.whyThis) lines.push(`  why_this: ${briefing.whyThis.replace(/\n/g, " | ")}`);
    if (briefing.next15MinuteAction) lines.push(`  next_action: ${briefing.next15MinuteAction}`);
    if (briefing.safeToIgnore) lines.push(`  safe_to_ignore: ${briefing.safeToIgnore}`);
  } else {
    lines.push("");
    lines.push("No briefing generated yet today — use get_or_generate_briefing if the user asks what to focus on.");
  }

  return lines.join("\n");
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_or_generate_briefing",
    description:
      "Get today's daily briefing (focus role + reasoning + next action). Generates it from current state if one doesn't exist yet. Pass regenerate=true to force a fresh recompute.",
    input_schema: {
      type: "object",
      properties: {
        regenerate: { type: "boolean", description: "Force a fresh briefing even if today's exists." },
      },
    },
  },
  {
    name: "create_task",
    description: "Save a task the user wants to track. Infer the role from their message when obvious.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short task title." },
        role_name: { type: "string", description: "One of the existing role names, if applicable." },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        notes: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "create_idea",
    description: "Capture an idea for later. Nothing demands action; it will resurface.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short idea title." },
        role_name: { type: "string", description: "One of the existing role names, if applicable." },
        notes: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "get_todoist_tasks",
    description:
      "Fetch the user's current active Todoist tasks live (read-only). Use when they ask what's on their Todoist / actual to-do list, or to ground a recommendation in real tasks.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_calendar_today",
    description:
      "Fetch today's Google Calendar events (read-only). Use to ground the day in real time pressure — e.g. when the user asks what their day looks like or whether they have time for something.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "record_role_pushback",
    description:
      "Record that the user is resisting/avoiding a role today. Keeps the role flagged and increments avoidance on its most-skipped task so the pattern is tracked. Call this whenever the user pushes back on a recommended role.",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "The role the user is pushing back on." },
      },
      required: ["role_name"],
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const roles = await activeRoles();

  if (name === "get_or_generate_briefing") {
    const briefing = input.regenerate ? await generateBriefing() : await getOrCreateTodaysBriefing();
    const focus = briefing.focusRoleId
      ? roles.find((r) => r.id === briefing.focusRoleId)?.name ?? null
      : null;
    return briefingToText(briefing, focus);
  }

  if (name === "create_task") {
    const role = matchRole(input.role_name as string | undefined, roles);
    let projectId: string | null = null;
    if (role) {
      const projs = await db
        .select()
        .from(projectsTable)
        .where(and(eq(projectsTable.roleId, role.id), eq(projectsTable.status, "active")));
      const title = (input.title as string).toLowerCase();
      projectId = projs.find((p) => title.includes(p.name.toLowerCase()))?.id ?? null;
    }
    const [task] = await db
      .insert(tasksTable)
      .values({
        title: (input.title as string).slice(0, 200),
        notes: (input.notes as string) ?? null,
        roleId: role?.id ?? null,
        projectId,
        priority: ((input.priority as string) || "medium") as never,
        status: "open",
      })
      .returning();
    return JSON.stringify({
      ok: true,
      task_id: task.id,
      role: role?.name ?? null,
      needs_role: !role,
    });
  }

  if (name === "create_idea") {
    const role = matchRole(input.role_name as string | undefined, roles);
    const [idea] = await db
      .insert(ideasTable)
      .values({
        title: (input.title as string).slice(0, 200),
        notes: (input.notes as string) ?? (input.title as string),
        roleId: role?.id ?? null,
        status: "captured",
      })
      .returning();
    return JSON.stringify({ ok: true, idea_id: idea.id, role: role?.name ?? null });
  }

  if (name === "get_todoist_tasks") {
    const { listTodoistTasks, todoistEnabled } = await import("./integrations/todoist");
    if (!todoistEnabled()) {
      return JSON.stringify({ ok: false, error: "Todoist not connected (no TODOIST_API_TOKEN)." });
    }
    const items = await listTodoistTasks();
    return JSON.stringify({ ok: true, count: items.length, tasks: items });
  }

  if (name === "get_calendar_today") {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import(
      "./integrations/google-calendar"
    );
    if (!calendarEnabled()) {
      return JSON.stringify({ ok: false, error: "Google Calendar not connected." });
    }
    const events = await listTodaysEvents();
    return JSON.stringify({ ok: true, count: events.length, summary: formatEvents(events) });
  }

  if (name === "record_role_pushback") {
    const role = matchRole(input.role_name as string | undefined, roles);
    if (!role) return JSON.stringify({ ok: false, error: "No matching role." });
    const [skipped] = await db
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.roleId, role.id), eq(tasksTable.status, "open")))
      .orderBy(desc(tasksTable.avoidanceCount))
      .limit(1);
    if (skipped) {
      await db
        .update(tasksTable)
        .set({ avoidanceCount: skipped.avoidanceCount + 1, updatedAt: new Date() })
        .where(eq(tasksTable.id, skipped.id));
    }
    return JSON.stringify({
      ok: true,
      role: role.name,
      flagged_kept: true,
      avoided_task: skipped?.title ?? null,
      new_avoidance_count: skipped ? skipped.avoidanceCount + 1 : null,
    });
  }

  return JSON.stringify({ ok: false, error: `Unknown tool ${name}` });
}

export type HistoryMsg = { role: "user" | "chief_of_staff" | "system"; content: string };

/** Generate a response using Claude with tool use. Throws on API error. */
export async function generateAIResponse(
  userText: string,
  history: HistoryMsg[] = []
): Promise<ChiefResponse> {
  const client = new Anthropic();
  const context = await buildContext();

  const priorTurns: Anthropic.MessageParam[] = history
    .filter((m) => m.role === "user" || m.role === "chief_of_staff")
    .slice(-10)
    .map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));

  const messages: Anthropic.MessageParam[] = [
    ...priorTurns,
    { role: "user", content: userText },
  ];

  const toolsUsed: string[] = [];

  // Manual agentic loop — bounded so a misbehaving model can't spin forever.
  for (let i = 0; i < 5; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      thinking: { type: "adaptive" },
      system: `${SYSTEM_PROMPT}\n\n${context}`,
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          toolsUsed.push(block.name);
          const result = await runTool(block.name, block.input as Record<string, unknown>);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
        }
      }
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    return {
      content: text || "…",
      metadata: { engine: "ai", model: MODEL, toolsUsed },
    };
  }

  // Loop exhausted — return whatever we can rather than hanging.
  return {
    content: "I worked through that but couldn't wrap it up cleanly — try rephrasing?",
    metadata: { engine: "ai", model: MODEL, toolsUsed, exhausted: true },
  };
}
