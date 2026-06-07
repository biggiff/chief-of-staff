import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, ilike } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  proposedUpdates as proposedUpdatesTable,
  activityLog as activityTable,
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
  findSimilarIdeas,
  findSimilarOpenTasks,
  appendIdeaNote,
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

// Canonical Scout voice (see memory: scout-personality-and-ux). Reused by the
// chat brain and the home-screen voicing helper.
export const SCOUT_VOICE = `You are Scout — a warm, observant, confident friend who knows Selena's life extremely well and helps her keep her shit together. You are NOT a productivity coach, therapist, corporate consultant, or a bot that reports information. You're the friend who's known her for years, remembers her goals, and notices her patterns.

Your real job isn't task management — it's helping her focus on what actually matters. You notice avoidance, repeated decisions, neglected priorities, recurring themes, and the gap between what she says matters and where her attention actually goes. You surface these naturally, like a friend would.

How you talk:
- Natural. Contractions, plain language, concise — 1 to 3 short paragraphs. Never sound like a report, documentation, a meeting summary, or a productivity blog.
- Lead with the conclusion. Say "Founder keeps getting pushed to tomorrow," not "Founder has not received meaningful attention in 9 days."
- Have opinions. Don't hedge. "I think Founder's the thing," not "You may want to consider focusing on Founder." You can be wrong and revise — just don't be wishy-washy.
- Humor: occasional, dry, earned from noticing a real pattern — never forced, no dad jokes, not in every message. Most replies have no joke. (Good: "You may have accidentally become CEO of Planning Things.")
- You can gently challenge her and name avoidance directly — but never shame, guilt, or lecture. (Good: "Do you not want to work on Founder, or not want to do the specific task in front of you?")
- Encouragement is rare and grounded — never a motivational poster. (Good: "That's real progress." Never: "You've got this!")
- Care and notice; don't worry or therapize. (Good: "You and Mandy are running like a team — the connection piece is what I'm watching." Never: "I'm worried about your relationship" or "How does that make you feel?")
- Never use internal jargon with her: no scores, no "role health," no "attention events," no "Crossroads/Observations" as labels. You may mention Compass occasionally as a trusted map ("Compass keeps pointing back to Founder"), never as a system ("according to Compass role scoring").

When in doubt: human over professional, conversational over informative, observation over analysis, clarity over completeness.`;

const SYSTEM_PROMPT = `${SCOUT_VOICE}

Behind the scenes you quietly maintain Compass (her roles, projects, tasks, attention, decisions, observations) using tools — but you talk like a friend, never like software.

How you maintain things (confidence policy):
- HIGH (she clearly states a fact or request): just do it, confirm in ONE short line. "spent an hour on PTO" → log_attention; "add idea: snack station" → create_idea; "finished the orthodontist call" → complete_task; "add task: order shirts" → create_task; "that's a Parent thing" → reassign.
- MEDIUM (vague or ongoing, not a clear instruction): ask ONE quick question before writing.
- LOW (you're inferring something she didn't say): don't write — say it as a hunch, or queue it with propose_update.

Attention types: focused_work, progress (built/shipped something), planning, thinking, relationship, maintenance, rest. "worked on/built X" = progress or focused_work; "thought about X" = thinking; "date night / good talk" = relationship; "cleaned/laundry/errands" = maintenance.

Tasks & reminders live in Todoist (the source of truth). create_task/complete_task go through Todoist. You CAN set due dates AND times via due_string ("today at 3pm", "tomorrow morning", "Friday at 10am") — use it for timed reminders and confirm exactly what you scheduled (Todoist delivers it; don't promise a push beyond that). If a time/date is ambiguous, ask one short question. For complete_task, pass her wording; if the match is unclear, ask which one.

Ideas: when create_idea reports duplicateFound, don't duplicate — ask whether to add a note (add_idea_note) or make a new one (force=true).

No duplicate tasks: when create_task reports duplicateFound, do NOT create another — tell her that one's already on the list and ask if she really wants a second (force=true only after she confirms). Never create the same task repeatedly.

Email (Gmail): you can read her mail across all folders (search_emails uses Gmail search syntax — use "in:anywhere" to include all folders/spam/trash, plus operators like from:, subject:, is:unread, newer_than:7d, label:), open a specific message (read_email), and create drafts (create_email_draft). SENDING is different: NEVER call send_email without her explicit go-ahead in the conversation. Default to writing the draft and asking "Want me to send it?" — only send_email after she clearly says yes. Summarize, don't dump raw headers.

Email labels = life areas. She labels forwarded mail by which part of her life it's from (e.g. Bakery, PTO, Founder). search_emails and read_email return each email's labels — surface them and use them to route/group ("3 unread under PTO"). To filter by one, search with label:"Name" (use list_email_labels if you need the exact names).

Trust: confirm briefly what changed; don't over-explain unless she asks why. Every action is undoable ("undo that").

CRITICAL: act ONLY on her most recent message. Earlier messages are context already handled — never re-log, re-create, or repeat a prior turn's write. If the latest message doesn't call for a write, don't make one.

When she asks "why," explain your thinking from what Compass shows (what's gotten attention, what's slipped, what's due) — in plain language, like a friend explaining a hunch, not a report. The current picture is below; only the roles listed exist.`;

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
    description: "Create a task in Todoist (the source of truth) and mirror it in Compass. Infer the role when obvious. The result may report duplicateFound (a similar open task already exists) — if so, do NOT create another; confirm with the user, and only pass force=true if they want it anyway.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        role_name: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        due_string: { type: "string", description: "Natural-language due date/time e.g. 'tomorrow', 'friday at 10am'." },
        force: { type: "boolean", description: "Create even if a similar open task exists (only after the user confirms)." },
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
    description: "Capture an idea for later. The result may report a likely duplicate (duplicateFound) — if so, ask the user before creating. Pass force=true only after they confirm they want a new one.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        role_name: { type: "string" },
        notes: { type: "string" },
        force: { type: "boolean", description: "Create even if a similar idea exists (only after the user confirms)." },
      },
      required: ["title"],
    },
  },
  {
    name: "add_idea_note",
    description: "Append a note to an existing idea (e.g. when the user wants to add to a duplicate rather than create a new one). Pass the existing idea's title/wording as idea_query.",
    input_schema: {
      type: "object",
      properties: { idea_query: { type: "string" }, note: { type: "string" } },
      required: ["idea_query", "note"],
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
  {
    name: "search_emails",
    description:
      "Search/read the user's Gmail across all folders. `query` is Gmail search syntax (e.g. 'in:anywhere', 'from:mom', 'is:unread', 'subject:invoice', 'newer_than:7d', 'label:PTO'). Empty = recent inbox. Returns id/from/subject/date/snippet.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" }, max: { type: "number" } },
    },
  },
  {
    name: "read_email",
    description: "Read the full body of one email by id (from search_emails). Returns its labels too.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "list_email_labels",
    description: "List the user's Gmail labels (her life-area tags). Use to get exact names before filtering with label:.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_email_draft",
    description: "Create a Gmail draft (does NOT send). Safe to do when she asks you to write something.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email via Gmail. ONLY call this after the user has explicitly confirmed they want it sent — never on your own initiative.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
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

// Email actions aren't undoable, but we record them for transparency (Review page).
async function logEmailActivity(kind: string, summary: string, conversationId: string | null) {
  await db.insert(activityTable).values({ actionKind: kind, summary, source: "chat", conversationId });
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
    if (input.force !== true) {
      const similar = await findSimilarOpenTasks(input.title as string);
      if (similar.length && similar[0].score >= 70) {
        return j({
          ok: false,
          duplicateFound: true,
          existing: { title: similar[0].task.title },
        });
      }
    }
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
    if (input.force !== true) {
      const similar = await findSimilarIdeas(input.title as string);
      if (similar.length && similar[0].score >= 70) {
        return j({
          ok: false,
          duplicateFound: true,
          existing: { title: similar[0].idea.title, status: similar[0].idea.status },
        });
      }
    }
    const role = matchRole(input.role_name as string | undefined, roles);
    const { summary } = await createIdea({
      title: input.title as string,
      notes: (input.notes as string) ?? null,
      role,
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "add_idea_note") {
    const res = await appendIdeaNote({
      ideaQuery: input.idea_query as string,
      note: input.note as string,
      conversationId,
    });
    return j(res);
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
    const items = await listTodoistTasks(300); // return all active; don't silently truncate
    return j({ ok: true, count: items.length, tasks: items });
  }

  if (name === "get_calendar_today") {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import("./integrations/google-calendar");
    if (!calendarEnabled()) return j({ ok: false, error: "Google Calendar not connected." });
    const events = await listTodaysEvents();
    return j({ ok: true, count: events.length, summary: formatEvents(events) });
  }

  if (name === "list_email_labels") {
    const gmail = await import("./integrations/gmail");
    if (!gmail.gmailConfigured()) return j({ ok: false, error: "Gmail not connected." });
    try {
      return j({ ok: true, labels: await gmail.listLabels() });
    } catch (err) {
      return j({ ok: false, error: err instanceof Error ? err.message : "Gmail error" });
    }
  }

  if (name === "search_emails" || name === "read_email" || name === "create_email_draft" || name === "send_email") {
    const gmail = await import("./integrations/gmail");
    if (!gmail.gmailConfigured()) {
      return j({ ok: false, error: "Gmail not connected — re-run google:auth with Gmail scopes." });
    }
    try {
      if (name === "search_emails") {
        const emails = await gmail.listEmails((input.query as string) ?? "", (input.max as number) ?? 15);
        return j({ ok: true, count: emails.length, emails });
      }
      if (name === "read_email") {
        return j({ ok: true, email: await gmail.readEmail(input.id as string) });
      }
      if (name === "create_email_draft") {
        const id = await gmail.createDraft({
          to: input.to as string,
          subject: input.subject as string,
          body: input.body as string,
        });
        await logEmailActivity("email_draft", `Drafted email to ${input.to} — "${input.subject}"`, conversationId);
        return j({ ok: true, draftId: id });
      }
      // send_email
      const id = await gmail.sendEmail({
        to: input.to as string,
        subject: input.subject as string,
        body: input.body as string,
      });
      await logEmailActivity("email_sent", `Sent email to ${input.to} — "${input.subject}"`, conversationId);
      return j({ ok: true, sent: true, messageId: id });
    } catch (err) {
      return j({ ok: false, error: err instanceof Error ? err.message : "Gmail error" });
    }
  }

  return j({ ok: false, error: `Unknown tool ${name}` });
}

/**
 * Voice the home-screen "morning read" + one observation in Scout's voice.
 * One cheap, tool-free call; the result is cached on the briefing row so the
 * home screen doesn't hit the model on every load.
 */
export async function voiceMorningRead(input: {
  focusName: string | null;
  summary: string | null;
  whyThis: string | null;
  tasksDue: number;
  events: string[];
}): Promise<{ read: string; note: string }> {
  const client = new Anthropic();
  const user = `Write Scout's morning home screen for Selena. Respond ONLY with JSON: {"read": "...", "note": "..."}.

"read": one short line (Scout's voice) naming what today is really about. Lead with the conclusion. No jargon, no scores.
"note": one short "Scout noticed" observation worth flagging today (a pattern, an avoidance, a relationship thing). If nothing genuinely worth noting, use "".

Keep each under ~180 characters. Today's picture:
- Focus right now: ${input.focusName ?? "unclear"}
- Internal summary (rephrase, don't quote): ${input.summary ?? "—"}
- Why: ${input.whyThis?.replace(/\n/g, "; ") ?? "—"}
- Tasks due today: ${input.tasksDue}
- Today's calendar: ${input.events.length ? input.events.join(", ") : "nothing scheduled"}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    thinking: { type: "disabled" }, // tiny rephrase — no thinking budget needed
    system: SCOUT_VOICE,
    messages: [{ role: "user", content: user }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  try {
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    return { read: (parsed.read || "").toString(), note: (parsed.note || "").toString() };
  } catch {
    return { read: text.slice(0, 200), note: "" };
  }
}

export type HistoryMsg = { role: "user" | "chief_of_staff" | "system"; content: string };

export async function generateAIResponse(
  userText: string,
  history: HistoryMsg[] = [],
  conversationId: string | null = null,
  image?: { data: string; mediaType: string }
): Promise<ChiefResponse> {
  const client = new Anthropic();
  const context = await buildContext();

  const priorTurns: Anthropic.MessageParam[] = history
    .filter((m) => m.role === "user" || m.role === "chief_of_staff")
    .slice(-12)
    .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.content }));

  // Latest turn — multimodal if an image was attached.
  const latest: Anthropic.MessageParam = image
    ? {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: image.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
              data: image.data,
            },
          },
          { type: "text", text: userText || "Take a look at this — what do you think?" },
        ],
      }
    : { role: "user", content: userText };

  const messages: Anthropic.MessageParam[] = [...priorTurns, latest];
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
