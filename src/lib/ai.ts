import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, ilike } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  proposedUpdates as proposedUpdatesTable,
  type Role,
  type AttentionType,
} from "@/db";
import {
  scoreRoles,
  getLatestBriefing,
  getOrCreateTodaysBriefing,
  generateBriefing,
  briefingToText,
} from "./briefing";
import {
  activeRoles,
  matchRole,
  findOpenTask,
  logAttention,
  createTask,
  completeTask,
  createIdea,
  reassign,
  recordPushback,
  saveCheckin,
  undoLast,
} from "./operator";
import { formatDate } from "./dates";
import type { ChiefResponse } from "./chat-engine";

/**
 * Scout — the conversational Chief of Staff. Scout reasons over Compass (the
 * structured system of roles, projects, tasks, attention, decisions/crossroads,
 * and observations) and maintains it through conversation via tools.
 *
 * Confidence policy: HIGH → act + confirm briefly; MEDIUM → ask one quick
 * confirmation; LOW → never write, queue a proposed update or suggest. Every
 * write is logged and undoable. Falls back to the rule engine with no API key.
 */

export function aiEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const MODEL = process.env.COS_AI_MODEL || "claude-opus-4-8";

const SYSTEM_PROMPT = `You are Scout, the user's personal Chief of Staff. You reason over a structured system called Compass — the user's roles, projects, tasks, attention history, decisions (called "Crossroads"), and observations. The conversation is the product; Compass exists to support it. Your job is to interpret the user's life, recommend where attention should go, AND maintain Compass for them so they rarely need to open forms.

Voice: direct, concise, useful. No fluffy encouragement, no generic productivity advice. Interpret role *health*, not just task lists. Distinguish urgency from strategic importance. Surface neglected roles. Recommend one next 15-minute action when direction is needed.

You maintain Compass with tools. Apply this confidence policy strictly:
- HIGH confidence (the user clearly states a fact or request): act immediately, then confirm in ONE short line. Examples: "I spent an hour on PTO" → log_attention; "add idea: snack station" → create_idea; "I finished the orthodontist call" → complete_task; "add task: order shirts" → create_task; "that's a Parent thing" → reassign.
- MEDIUM confidence (vague or ongoing, not a clear instruction): ask ONE quick confirmation before writing. Examples: "I've been thinking about Doughrway a lot" → "Want me to log thinking time on Founder, or start a Doughrway project?"
- LOW confidence (you're inferring something the user didn't say): do NOT write. Either suggest it, or call propose_update to queue it for review. Examples: inferred avoidance, inferred decisions, inferred role changes.

Attention types (pick the best fit): focused_work, progress (built/shipped something), planning, thinking, relationship, maintenance, rest. "Built/worked on X" = progress or focused_work; "thought about X" = thinking; "date night / good talk with [partner]" = relationship; "cleaned / laundry / errands" = maintenance.

Tasks live in Todoist (the source of truth) — create_task and complete_task go through Todoist. For complete_task, pass the user's wording as the query; if the match is unclear, ask which one.

Trust rules: confirm briefly what changed; do NOT over-explain unless the user asks "why". Don't ask permission for obvious high-confidence actions. Every action is undoable ("undo that").

CRITICAL: Act ONLY on the user's most recent message. Earlier messages in the conversation are context that has ALREADY been handled — never re-log attention, re-create a task/idea, or repeat any write from a prior turn. If the latest message doesn't call for a write, don't make one.

When the user asks "why" you recommended something, answer from the Compass state below (role health, recent attention, open/overdue tasks, projects, check-ins). Use the term "Compass" naturally ("Compass shows…"). Only the roles listed below exist — match role names to that list.`;

async function focusRoleName(focusRoleId: string | null | undefined, roles: Role[]): Promise<string | null> {
  if (!focusRoleId) return null;
  return roles.find((r) => r.id === focusRoleId)?.name ?? null;
}

/** Snapshot of current Compass state for Scout's system prompt. */
async function buildContext(): Promise<string> {
  const scored = await scoreRoles();
  const briefing = await getLatestBriefing();

  const lines: string[] = [];
  lines.push("COMPASS STATE (computed by the rule-based engine):");
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
    if (s.attentionCredit > 0) bits.push(`recent_attention_credit=${s.attentionCredit}`);
    if (s.latestHealthScore != null) bits.push(`self_rated=${s.latestHealthScore}/10`);
    if (s.daysSinceAttention != null) bits.push(`days_since_attention=${s.daysSinceAttention}`);
    if (s.maxAvoidanceCount >= 2) bits.push(`avoided="${s.topAvoidedTaskTitle}"x${s.maxAvoidanceCount}`);
    lines.push(`- ${s.role.name}: ${bits.join(", ")}`);
  }

  // Unassigned open tasks (synced from Todoist, no role yet), grouped by list.
  const unassigned = await db
    .select()
    .from(tasksTable)
    .where(and(isNull(tasksTable.roleId), eq(tasksTable.status, "open")));
  if (unassigned.length) {
    const projRows = await db.select().from(projectsTable);
    const projName = new Map(projRows.map((p) => [p.id, p.name]));
    const groups = new Map<string, typeof unassigned>();
    for (const t of unassigned) {
      const key = t.projectId ? projName.get(t.projectId) ?? "Other" : "No list";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(t);
    }
    lines.push("");
    lines.push(`Unassigned open tasks (${unassigned.length}), grouped by list/project:`);
    for (const [group, items] of groups) {
      lines.push(`  ${group} (${items.length}):`);
      for (const t of items.slice(0, 6)) {
        const due = t.dueDate ? ` (due ${formatDate(t.dueDate)})` : "";
        lines.push(`    - ${t.title}${due}`);
      }
      if (items.length > 6) lines.push(`    …and ${items.length - 6} more`);
    }
  }

  try {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import("./integrations/google-calendar");
    if (calendarEnabled()) {
      const events = await listTodaysEvents();
      lines.push("");
      lines.push(`Today's calendar (${events.length}):`);
      lines.push(formatEvents(events));
    }
  } catch (err) {
    console.error("calendar context failed:", err);
  }

  if (briefing) {
    lines.push("");
    lines.push(`Latest briefing (${formatDate(briefing.briefingDate)}): ${briefing.summary ?? ""}`);
    if (briefing.whyThis) lines.push(`  why: ${briefing.whyThis.replace(/\n/g, " | ")}`);
  }

  return lines.join("\n");
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_or_generate_briefing",
    description: "Get today's briefing (focus role + reasoning + next action). Generates from Compass if none exists today. regenerate=true forces a fresh recompute (use after logging attention).",
    input_schema: { type: "object", properties: { regenerate: { type: "boolean" } } },
  },
  {
    name: "log_attention",
    description: "Log time/energy the user gave to a role. HIGH-confidence statements like 'I spent an hour on PTO' or 'great date night with Mandy'.",
    input_schema: {
      type: "object",
      properties: {
        role_name: { type: "string", description: "Existing role name." },
        attention_type: { type: "string", enum: ["focused_work", "progress", "planning", "thinking", "relationship", "maintenance", "rest"] },
        duration_minutes: { type: "number" },
        project_name: { type: "string" },
        notes: { type: "string" },
      },
      required: ["role_name", "attention_type"],
    },
  },
  {
    name: "create_task",
    description: "Create a task in Todoist (the source of truth) and mirror it in Compass. Infer the role when obvious.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        role_name: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        due_string: { type: "string", description: "Natural-language due date e.g. 'tomorrow', 'friday'." },
      },
      required: ["title"],
    },
  },
  {
    name: "complete_task",
    description: "Complete a task the user says they finished. Pass their wording as query; it fuzzy-matches an open task and closes it in Todoist. If the match is unclear, you'll get candidates back — ask which one.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "create_idea",
    description: "Capture an idea for later. Nothing demands action.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, role_name: { type: "string" }, notes: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "reassign",
    description: "Move a task or idea to a different role/project, e.g. 'that's actually a Parent thing'. Pass the user's wording as query.",
    input_schema: {
      type: "object",
      properties: {
        item_type: { type: "string", enum: ["task", "idea"] },
        query: { type: "string" },
        role_name: { type: "string" },
        project_name: { type: "string" },
      },
      required: ["item_type", "query"],
    },
  },
  {
    name: "save_checkin",
    description: "Save a quick check-in after you've asked the user: energy 1-10, overwhelm 1-10, biggest win, biggest concern, what they're avoiding. Call once you have their answers.",
    input_schema: {
      type: "object",
      properties: {
        energy: { type: "number" },
        overwhelm: { type: "number" },
        win: { type: "string" },
        concern: { type: "string" },
        avoiding: { type: "string" },
      },
    },
  },
  {
    name: "record_pushback",
    description: "The user is resisting a role today. Keeps it flagged and records avoidance. Acknowledge and offer a lower-friction alternative.",
    input_schema: { type: "object", properties: { role_name: { type: "string" } }, required: ["role_name"] },
  },
  {
    name: "undo_last",
    description: "Undo the most recent reversible action ('undo that', 'that was wrong').",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "propose_update",
    description: "For LOW-confidence inferences you should NOT write directly (inferred avoidance, decisions/crossroads, role changes, projects). Queues a proposed update for the user to review.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        summary: { type: "string", description: "Human-readable description of the proposed change." },
        confidence: { type: "string", enum: ["low", "medium"] },
      },
      required: ["kind", "summary"],
    },
  },
  {
    name: "get_todoist_tasks",
    description: "Fetch the user's current active Todoist tasks live (read-only), grouped by list.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_calendar_today",
    description: "Fetch today's Google Calendar events (read-only).",
    input_schema: { type: "object", properties: {} },
  },
];

async function resolveProjectId(roleId: string | null, projectName?: string): Promise<string | null> {
  if (!projectName || !roleId) return null;
  const [p] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.roleId, roleId), ilike(projectsTable.name, `%${projectName}%`)))
    .limit(1);
  return p?.id ?? null;
}

async function runTool(
  name: string,
  input: Record<string, unknown>,
  conversationId: string | null
): Promise<string> {
  const roles = await activeRoles();
  const j = (o: unknown) => JSON.stringify(o);

  if (name === "get_or_generate_briefing") {
    const briefing = input.regenerate ? await generateBriefing() : await getOrCreateTodaysBriefing();
    const focus = await focusRoleName(briefing.focusRoleId, roles);
    return briefingToText(briefing, focus);
  }

  if (name === "log_attention") {
    const role = matchRole(input.role_name as string, roles);
    if (!role) return j({ ok: false, error: "No matching role.", roles: roles.map((r) => r.name) });
    const projectId = await resolveProjectId(role.id, input.project_name as string | undefined);
    const { summary } = await logAttention({
      role,
      attentionType: (input.attention_type as AttentionType) ?? "focused_work",
      durationMinutes: (input.duration_minutes as number) ?? null,
      projectId,
      notes: (input.notes as string) ?? null,
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "create_task") {
    const role = matchRole(input.role_name as string | undefined, roles);
    const { task, summary } = await createTask({
      title: input.title as string,
      role,
      priority: (input.priority as "low" | "medium" | "high") ?? "medium",
      dueString: (input.due_string as string) ?? null,
      conversationId,
    });
    return j({ ok: true, summary, taskId: task.id, needsRole: !role });
  }

  if (name === "complete_task") {
    const { best, confident, candidates } = await findOpenTask(input.query as string);
    if (!best) return j({ ok: false, error: "No open task matched.", query: input.query });
    if (!confident) {
      return j({ ok: false, needsClarification: true, candidates: candidates.map((c) => c.task.title) });
    }
    const { summary } = await completeTask({ task: best, conversationId });
    return j({ ok: true, summary });
  }

  if (name === "create_idea") {
    const role = matchRole(input.role_name as string | undefined, roles);
    const { summary } = await createIdea({
      title: input.title as string,
      notes: (input.notes as string) ?? null,
      role,
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "reassign") {
    const role = matchRole(input.role_name as string | undefined, roles);
    let entityId: string | null = null;
    const query = (input.query as string) ?? "";
    if (input.item_type === "idea") {
      const [idea] = await db
        .select()
        .from(ideasTable)
        .where(ilike(ideasTable.title, `%${query}%`))
        .limit(1);
      entityId = idea?.id ?? null;
    } else {
      const { best } = await findOpenTask(query);
      entityId = best?.id ?? null;
    }
    if (!entityId) return j({ ok: false, error: "Couldn't find that item." });
    const projectId = await resolveProjectId(role?.id ?? null, input.project_name as string | undefined);
    const { summary } = await reassign({
      entityTable: input.item_type === "idea" ? "ideas" : "tasks",
      entityId,
      role,
      projectId,
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "save_checkin") {
    const { summary } = await saveCheckin({
      energy: (input.energy as number) ?? null,
      overwhelm: (input.overwhelm as number) ?? null,
      win: (input.win as string) ?? null,
      concern: (input.concern as string) ?? null,
      avoiding: (input.avoiding as string) ?? null,
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "record_pushback") {
    const role = matchRole(input.role_name as string, roles);
    if (!role) return j({ ok: false, error: "No matching role." });
    const { skipped } = await recordPushback({ role, conversationId });
    return j({ ok: true, role: role.name, flaggedKept: true, avoidedTask: skipped?.title ?? null });
  }

  if (name === "undo_last") {
    const res = await undoLast();
    return j(res);
  }

  if (name === "propose_update") {
    const [row] = await db
      .insert(proposedUpdatesTable)
      .values({
        conversationId,
        kind: input.kind as string,
        summary: input.summary as string,
        confidence: ((input.confidence as string) ?? "low") as never,
        status: "pending",
      })
      .returning();
    return j({ ok: true, queued: true, proposalId: row.id });
  }

  if (name === "get_todoist_tasks") {
    const { listTodoistTasks, todoistEnabled } = await import("./integrations/todoist");
    if (!todoistEnabled()) return j({ ok: false, error: "Todoist not connected." });
    const items = await listTodoistTasks();
    return j({ ok: true, count: items.length, tasks: items });
  }

  if (name === "get_calendar_today") {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import("./integrations/google-calendar");
    if (!calendarEnabled()) return j({ ok: false, error: "Google Calendar not connected." });
    const events = await listTodaysEvents();
    return j({ ok: true, count: events.length, summary: formatEvents(events) });
  }

  return j({ ok: false, error: `Unknown tool ${name}` });
}

export type HistoryMsg = { role: "user" | "chief_of_staff" | "system"; content: string };

export async function generateAIResponse(
  userText: string,
  history: HistoryMsg[] = [],
  conversationId: string | null = null
): Promise<ChiefResponse> {
  const client = new Anthropic();
  const context = await buildContext();

  const priorTurns: Anthropic.MessageParam[] = history
    .filter((m) => m.role === "user" || m.role === "chief_of_staff")
    .slice(-12)
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  const messages: Anthropic.MessageParam[] = [...priorTurns, { role: "user", content: userText }];
  const toolsUsed: string[] = [];

  for (let i = 0; i < 6; i++) {
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
          const result = await runTool(block.name, block.input as Record<string, unknown>, conversationId);
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
    return { content: text || "…", metadata: { engine: "ai", model: MODEL, toolsUsed } };
  }

  return {
    content: "I worked through that but couldn't wrap it up cleanly — try rephrasing?",
    metadata: { engine: "ai", model: MODEL, toolsUsed, exhausted: true },
  };
}
