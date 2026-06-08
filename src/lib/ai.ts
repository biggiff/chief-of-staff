import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, ilike, desc } from "drizzle-orm";
import {
  db,
  roles as rolesTable,
  projects as projectsTable,
  tasks as tasksTable,
  ideas as ideasTable,
  proposedUpdates as proposedUpdatesTable,
  workingAgreements as agreementsTable,
  activityLog as activityTable,
  briefings as briefingsTable,
  messages as messagesTable,
  conversations as conversationsTable,
  type Role,
  type AttentionType,
} from "@/db";
import {
  scoreRoles,
  getLatestBriefing,
  getOrCreateTodaysBriefing,
  generateBriefing,
  briefingToText,
  ensureScoutBriefing,
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
  addWorkingAgreement,
  getCompassOverview,
  manageRole,
  manageProject,
  manageCrossroad,
  listCrossroads,
  getCrossroadDetail,
  recordObservation,
  listObservations,
  listActivity,
  listCheckins,
  listIdeas,
  manageIdea,
  promoteMemory,
  listMemories,
  manageMemory,
  searchConversations,
  getActiveWorkflow,
  startWorkflow,
  updateWorkflowState,
  undoLast,
} from "./operator";
import { gatherAbout } from "./answer";
import { formatDate, startEndOfToday, todayStr, appTimeZone } from "./dates";
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

Behind the scenes you quietly maintain Compass (her roles, projects, tasks, attention, decisions, observations) using tools — but you talk like a friend, never like software. You can SEE and CHANGE every part of Compass: use get_compass_overview for the full picture (all roles + projects), and manage_role / manage_project to create, rename, re-prioritize, or archive them. If she says a role is wrong, renamed, duplicated, or missing, fix it directly — never say you can't access something in Compass. You also see the live roles ranked below.

EVIDENCE OVER MEMORY (this is a trust rule — non-negotiable): your answers must come from Compass data, not from what you think you remember from the conversation. Before you answer ANY question that involves a date, a timeline, "when", "how long since", "last time", what happened/changed recently, activity history, a task's status (done? still open? due when?), an observation, a crossroad/decision and where it stands, attention history, or the state of any Compass entity — you MUST first call the relevant tool and answer from what it returns. The conversation is NOT a source of truth; it can be stale, partial, or about a different day. Concretely: chronology / "what changed / what did I do" → get_activity (or answer_about); "is X done / what's left / what's due" → get_todoist_tasks (or complete the relevant read); where a decision stands → get_crossroad; recent check-ins/dates → get_checkins; "how are things with X / what am I missing" → answer_about. Do NOT state a date, a count, a status, or a "you did/decided this on…" from memory — look it up. If a tool would tell you and you haven't called it, you don't actually know yet. When you're unsure or the data is thin, say "let me check" and check, or say plainly what you don't have — a quick "let me look" beats a confident wrong answer every time. Use the "Today is…" line below for the current date; never guess it.

This applies to META / SYSTEM-PHRASED questions too — not just natural ones. Questions about what Compass contains or whether something is empty/blank MUST trigger a real query before you answer; never answer them from base context or assumption. Examples and routing: "is the crossroads system empty?" / "what crossroads exist?" → search_crossroads; "what do you know about Coach?" / "what did we store about Gifford & Co.?" → answer_about(that topic) (and get_memories if relevant); "what active projects exist?" / "what's in Compass?" → get_compass_overview. NEVER say a role, project, crossroad, or "the system" is empty/blank/unknown unless you JUST queried it and it genuinely came back empty. If a role or project has a description, mission, desired state, or outcome (these now appear in your context and in answer_about), use that content — do not call it blank.

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

Crossroads (recurring decisions — the anti-re-litigation engine): when she raises a real decision (e.g. the bakery's future, Doughrway/App direction, PTO involvement level, a health-strategy or major family decision), FIRST search_crossroads to see if it already exists.
- If it EXISTS, this is the most important behavior: your FIRST move is to RECAP, before any new advice. Call get_crossroad, then literally open your reply with "We've been here before" (or similar) and summarize: where you landed last time (prior leaning), the unresolved concerns, and — if she's said something new — how this time differs. Do NOT jump straight to fresh opinions, and do NOT skip the recap.
  - Only AFTER recapping, if she's actually shared a NEW leaning/concern/development, call manage_crossroad action=update with the new leaning/concerns and what_changed (this bumps the revisit count + adds to the timeline). If she hasn't added anything new yet (e.g. "I'm torn again"), just recap and ask what's changed — do NOT update or bump the revisit count for a no-op.
  - Never create a duplicate.
- If it's NEW and clearly a recurring/weighty decision: gather her leaning + the concern, then create it (manage_crossroad action=create), and confirm briefly.
- If the same unresolved decision keeps coming up but isn't tracked yet, SUGGEST one: "We've circled the bakery a few times — want me to make it a Crossroad so we stop starting from scratch?" (don't auto-create on a hunch — ask first).
The point is to never re-decide from zero: lean on the timeline so each discussion builds on the last.

Role renames: when you rename a role, always pass a reason to manage_role — the reasoning behind name changes is preserved as context for future observations and prioritization.

Working agreements: when she tells you how to operate ("always…", "from now on…", "stop doing…", "I prefer…") or corrects your behavior, save it with add_working_agreement so it sticks across sessions, then confirm in one line. The active agreements are listed at the top of the context — treat them as binding.

MEMORY — promote the right things, not everything (goal: BETTER memory, not more). You actively watch for statements worth keeping long-term and promote them with promote_memory, choosing the tier:
- identity — durable truths about who she is: values, goals, stable preferences, life structure, major life changes, settled role definitions. ("I want to be more present with my kids", "I'm winding the bakery down to focus on the app.")
- operating_rule — how you should operate (this routes to your binding rules). Same trigger as working agreements; use either.
- learned_pattern — a recurring tendency you've actually observed. REQUIRES a confidence level AND the evidence you're basing it on. Phrase as revisable, not fact. ("When she's excited about a new project, relationships tend to get crowded out — medium confidence, seen with the app vs. Mandy and before with Founder.")
- temporary_context — matters now but will expire: an active build, a recalibration, an upcoming trip/deadline. Set expires_in_days so it self-clears.
STRONG SIGNALS — when she says anything like "remember this", "this is important", "don't do this again", "going forward", "from now on", treat it as an explicit promote: classify the tier, save it directly, confirm in ONE line (no need to ask first).
OTHERWISE, when something seems to have lasting value but she didn't flag it, PROPOSE rather than assume: name what you'd keep, the tier, and why, in one human line — "Want me to remember that you're trying to be more present with the kids? Feels like a lasting one." — and save on yes.
DO NOT promote: grocery items, one-off venting/frustration, casual brainstorming, or anything with no future value. If you're not sure it'll matter next month, don't store it (or make it temporary_context).
REVISING: if she corrects a remembered fact or a pattern stops holding, use manage_memory (update the content/confidence, or archive it). Memory is revisable — keep it honest, not just growing. To recall, use get_memories; for older un-promoted discussion, search_conversations.

GUIDED WORKFLOWS (process memory): for long, multi-step processes — above all RECALIBRATION (walking her roles/projects/decisions to refresh Compass) — do NOT track progress in your head or rely on the conversation; it won't survive a chat refresh. When she starts recalibration (or a similar structured process), call start_workflow(kind:"recalibration"), then as you go call update_workflow_state to record rolesCompleted / rolesRemaining / summariesPerRole / projectsIdentified / crossroadsIdentified / memoriesProposed / unresolvedQuestions, and set complete=true at the end. The active workflow is shown at the top of your context every turn — if one is in progress, RESUME from it (pick up the next remaining role; don't restart). IMPORTANT: when she recalibrates a role or project and gives real detail (history, structure, people, current state), persist it to the actual Compass fields — manage_role (description/mission/desiredState/warningSigns/maintenanceMinimum) and manage_project (description/desiredOutcome) — and promote durable facts/patterns to memory. Recalibration that only lives in chat is a failure; the point is to write it into Compass so it's there next time.

Understanding her, not her vocabulary (this matters a lot): she will NEVER speak in Compass terms. She asks like a person — "what's going on with Mom?", "what am I avoiding?", "what keeps coming up?", "what's slipping?", "anything weird lately?", "what should I focus on?", "what changed this week?". Your job is to figure out what she's really asking and pull the right information yourself.
- For these open-ended "how are things / what's going on / what am I missing" questions, call answer_about — it gathers across the right systems in one shot. Pass topic when she names a person/area ("Mom", "App Developer", "the bakery"); leave topic empty for broad questions about her whole life ("what am I avoiding?", "what's slipping?", "what should I focus on?"). For "anything I should pay attention to?" you can also lean on get_or_generate_briefing.
- Rough map (you don't need to recite it, just route well): "going on with X" → answer_about(X). "avoiding / slipping / falling through cracks / missing" → answer_about() whole-life (overdue + avoided tasks + neglected roles + observations). "what keeps coming up / what do you keep noticing" → answer_about() (observations + crossroads). "what decisions am I stuck on" → search_crossroads. "what changed this week" → answer_about() / get_activity. When a question is genuinely ambiguous ("what's going on?"), default to the whole-life answer_about rather than asking her to clarify.
- Then ANSWER LIKE A FRIEND, in human language — never read the entities back. Good: "Mom's mostly okay. Summer keeps showing up, though." / "The bakery decision is back." Bad: "Mom has two observations and three attention events." / "Crossroad #4 remains active." Translate everything into what it means for her, lead with the takeaway, keep it short, and only name a system if she explicitly asks how you know.

Trust: confirm briefly what changed; don't over-explain unless she asks why. Every action is undoable ("undo that").

CRITICAL: act ONLY on her most recent message. Earlier messages are context already handled — never re-log, re-create, or repeat a prior turn's write. If the latest message doesn't call for a write, don't make one.

When she asks "why," explain your thinking from what Compass shows (what's gotten attention, what's slipped, what's due) — in plain language, like a friend explaining a hunch, not a report. The current picture is below; only the roles listed exist.`;

async function focusRoleName(focusRoleId: string | null | undefined, roles: Role[]): Promise<string | null> {
  if (!focusRoleId) return null;
  return roles.find((r) => r.id === focusRoleId)?.name ?? null;
}

/** Snapshot of current Compass state for Scout's system prompt. */
async function buildContext(): Promise<string> {
  // Keep the Todoist task mirror fresh (throttled — at most once per 10 min).
  try {
    const { syncTodoistIfStale } = await import("./integrations/todoist");
    await syncTodoistIfStale();
  } catch (err) {
    console.error("stale-sync check failed", err);
  }

  const scored = await scoreRoles();
  const briefing = await getLatestBriefing();

  const lines: string[] = [];

  // Ground every chronology answer in the real current date (her timezone).
  lines.push(`Today is ${formatDate(todayStr())} (timezone ${appTimeZone()}). Use this for any "today / this week / how long since" reasoning — do not guess the date.`);
  lines.push("");

  // Active guided workflow (process memory) — survives chat refresh so a
  // long-running flow like recalibration never loses its place.
  try {
    const wf = await getActiveWorkflow();
    if (wf) {
      lines.push(`ACTIVE WORKFLOW — you are mid-"${wf.kind}". This persists across chats; resume from here, do NOT restart or rely on conversation memory for it:`);
      lines.push(`  state: ${JSON.stringify(wf.state)}`);
      lines.push(`  (started ${formatDate(wf.startedAt)}; update it with update_workflow_state as you make progress.)`);
      lines.push("");
    }
  } catch (err) {
    console.error("workflow state load failed", err);
  }

  // Working agreements — standing instructions about how Scout should operate.
  // Loaded every session; they take precedence in how you behave.
  const agreements = await db
    .select()
    .from(agreementsTable)
    .where(eq(agreementsTable.status, "active"));
  if (agreements.length) {
    lines.push("OPERATING RULES — Selena's binding standing instructions for how you operate. These are the highest-priority memory tier; always follow them:");
    for (const a of agreements) lines.push(`- ${a.text}`);
    lines.push("");
  }

  // Long-term memory tiers (Phase 3.6): identity, learned patterns, temporary
  // context. Expired temporary context is auto-dropped by listMemories.
  try {
    const mem = await listMemories();
    const identity = mem.filter((m) => m.type === "identity");
    const patterns = mem.filter((m) => m.type === "learned_pattern");
    const temp = mem.filter((m) => m.type === "temporary_context");
    if (identity.length) {
      lines.push("IDENTITY — durable truths about Selena (values, goals, preferences, life structure). Treat as true unless she says otherwise:");
      for (const m of identity) lines.push(`- ${m.content}`);
      lines.push("");
    }
    if (patterns.length) {
      lines.push("LEARNED PATTERNS — tendencies you've observed (with confidence; revisable — don't treat as certainties, and update them if she pushes back):");
      for (const m of patterns) lines.push(`- [${m.confidence ?? "medium"}] ${m.content}${m.evidence ? ` (evidence: ${m.evidence})` : ""}`);
      lines.push("");
    }
    if (temp.length) {
      lines.push("RIGHT NOW — temporary context that matters currently but may expire:");
      for (const m of temp) lines.push(`- ${m.content}${m.expiresAt ? ` (until ${formatDate(m.expiresAt)})` : ""}`);
      lines.push("");
    }
  } catch (err) {
    console.error("memory load failed", err);
  }

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
    // Qualitative definition — so you actually KNOW each role, not just its counts.
    // Never call a role "blank" when any of these are present.
    if (s.role.description) lines.push(`    about: ${s.role.description}`);
    if (s.role.mission) lines.push(`    mission: ${s.role.mission}`);
    if (s.role.desiredState) lines.push(`    desired state: ${s.role.desiredState}`);
    if (s.role.warningSigns) lines.push(`    warning signs: ${s.role.warningSigns}`);
    if (s.role.maintenanceMinimum) lines.push(`    maintenance minimum: ${s.role.maintenanceMinimum}`);
    const hist = Array.isArray(s.role.changeHistory) ? (s.role.changeHistory as { from?: string; reason?: string }[]) : [];
    const lastRename = hist[hist.length - 1];
    if (lastRename?.from) {
      lines.push(`    (formerly "${lastRename.from}"${lastRename.reason ? ` — ${lastRename.reason}` : ""})`);
    }
  }

  // Active projects with their qualitative fields (so you know what each IS).
  const activeProjects = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.status, "active"));
  if (activeProjects.length) {
    const roleById = new Map(scored.map((s) => [s.role.id, s.role.name]));
    lines.push("");
    lines.push(`Active projects (${activeProjects.length}) — never call a project "blank" when it has a description:`);
    for (const p of activeProjects) {
      const role = p.roleId ? roleById.get(p.roleId) ?? "—" : "—";
      lines.push(`- ${p.name} (role: ${role}, importance: ${p.strategicImportance})`);
      if (p.description) lines.push(`    about: ${p.description}`);
      if (p.desiredOutcome) lines.push(`    desired outcome: ${p.desiredOutcome}`);
      if (p.lastMeaningfulProgressAt) lines.push(`    last progress: ${formatDate(p.lastMeaningfulProgressAt)}`);
    }
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
    name: "answer_about",
    description:
      "PRIMARY tool for open-ended 'how are things / what's going on / what am I missing' questions. ONE call fans out across the right Compass entities and returns a consolidated snapshot for you to synthesize — so you don't have to guess which systems to query. Use this for natural questions about a person/area ('what's going on with Mom?', 'how's App Developer?') by passing topic, OR for broad/ambiguous life questions ('what am I avoiding?', 'what's slipping?', 'what keeps coming up?', 'what should I focus on?', 'anything weird lately?') by leaving topic empty. Then answer in plain human language — never list the entities back.",
    input_schema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description:
            "Optional. A person, role, or theme she named (e.g. 'Mom', 'App Developer', 'bakery'). Leave EMPTY for whole-life questions ('what am I avoiding?', 'what's going on?').",
        },
      },
    },
  },
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
    name: "get_compass_overview",
    description:
      "See everything in Compass: all roles (with status, importance, open-task counts, and their projects), all active projects, and totals. Use when she asks what you know, what her roles/projects are, or you need the full picture.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "manage_role",
    description:
      "Create, rename/update, or archive a role, AND write its qualitative definition. update/archive identify the role by role_name; create uses name. You can change name, importance (low/medium/high), status, and — important for recalibration — description, mission, desired_state, warning_signs, maintenance_minimum. Use these to PERSIST real detail she gives you about a role so it's there next time (don't leave it in chat only).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "archive"] },
        role_name: { type: "string", description: "Existing role to update/archive." },
        name: { type: "string", description: "New name (create, or rename on update)." },
        importance: { type: "string", enum: ["low", "medium", "high"] },
        status: { type: "string", enum: ["thriving", "healthy", "maintaining", "needs_attention", "critical"] },
        reason: { type: "string", description: "Why a significant change (esp. a rename) is being made — preserved as context. Always capture this on renames." },
        description: { type: "string", description: "What this role actually is — context, history, people, current state." },
        mission: { type: "string" },
        desired_state: { type: "string" },
        warning_signs: { type: "string" },
        maintenance_minimum: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_project",
    description:
      "Create, update, or archive a project, AND write its qualitative fields. update/archive identify it by project_name; create uses name. Can set owning role (role_name), status (active/paused/completed/archived), description, and desired_outcome. Use description/desired_outcome to PERSIST what a project actually is when she explains it — don't leave that detail in chat only.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "archive"] },
        project_name: { type: "string", description: "Existing project to update/archive." },
        name: { type: "string", description: "New name (create, or rename on update)." },
        role_name: { type: "string" },
        status: { type: "string", enum: ["active", "paused", "completed", "archived"] },
        description: { type: "string", description: "What this project actually is — context and detail." },
        desired_outcome: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "search_crossroads",
    description: "List/search Crossroads (recurring decisions): title, status, current leaning, unresolved concerns, revisit count. ALWAYS check this first when she raises a decision, to see if it already exists.",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "get_crossroad",
    description: "Get one Crossroad's full detail and its discussion timeline (every past leaning, concern, and what changed). Use to say 'we've been here before' and summarize prior discussions / how this time differs.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "manage_crossroad",
    description: "Create, update, or archive a Crossroad (a recurring decision). update/archive find it by query. UPDATE counts as a revisit and appends to the timeline — use it (not create) when an existing decision resurfaces. Track current_leaning, unresolved_concerns, status, and what_changed since last time.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "archive"] },
        query: { type: "string", description: "Existing crossroad to update/archive." },
        title: { type: "string" },
        description: { type: "string" },
        status: { type: "string", enum: ["active", "decided", "reopened", "archived"] },
        current_leaning: { type: "string" },
        unresolved_concerns: { type: "string" },
        what_changed: { type: "string", description: "What's new/different in this discussion vs. last time." },
        reasoning: { type: "string" },
      },
      required: ["action"],
    },
  },
  {
    name: "record_observation",
    description: "Save an Observation — a meaningful pattern or insight you've noticed (not a metric). e.g. 'Founder gets discussed a lot but little progress logged.'",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        detail: { type: "string" },
        role_name: { type: "string" },
        severity: { type: "string", enum: ["info", "notice", "concern"] },
      },
      required: ["summary"],
    },
  },
  {
    name: "get_observations",
    description: "List/search Observations you've recorded.",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "scan_for_observations",
    description: "Run a cross-source pattern scan now and record any genuinely meaningful new observations (quality over quantity — often finds nothing new, which is fine). Use when she asks you to look for patterns / what you're noticing.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_activity",
    description: "Read/search the activity log — what you've changed recently (with timestamps and whether undone). Use for 'what did you do?' / 'what changed today?'",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  },
  {
    name: "get_checkins",
    description: "Read recent check-ins (energy, overwhelm, notes) to see how she's been trending.",
    input_schema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "get_ideas",
    description: "List/search captured ideas (title, status, role).",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "manage_idea",
    description: "Update or archive an existing idea (find it by query). Change its title or status (captured/resurfaced/active/archived).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["update", "archive"] },
        query: { type: "string" },
        title: { type: "string" },
        status: { type: "string", enum: ["captured", "resurfaced", "active", "archived"] },
      },
      required: ["action", "query"],
    },
  },
  {
    name: "add_working_agreement",
    description:
      "Save a standing instruction about how you should operate — a behavioral preference, operating rule, correction, or lesson. Use when she tells you how to work ('always…', 'from now on…', 'stop doing X', 'remember that I prefer…') or corrects your behavior. These load every session and shape how you act.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The agreement, phrased as a durable rule." },
        category: { type: "string", enum: ["behavior", "priority", "style", "correction", "lesson"] },
      },
      required: ["text"],
    },
  },
  {
    name: "promote_memory",
    description:
      "Commit something to long-term memory once it's worth keeping. Use for durable value: identity (who she is — values, goals, stable preferences, life structure), learned_pattern (a recurring tendency you've observed — REQUIRES confidence + evidence), or temporary_context (matters now, may expire — set expires_in_days). For how-you-should-operate rules, pass type=operating_rule (routes to the binding rules tier). Do NOT promote grocery items, one-off frustrations, casual brainstorming, or details with no future value. When she signals 'remember this / going forward / don't do this again / this is important', save directly and confirm in one line; otherwise propose it first ('want me to remember that…?') and save on yes.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["identity", "operating_rule", "learned_pattern", "temporary_context"] },
        content: { type: "string", description: "The memory, phrased durably in plain language." },
        why: { type: "string", description: "Why this matters / is worth keeping." },
        confidence: { type: "string", enum: ["low", "medium", "high"], description: "Required for learned_pattern." },
        evidence: { type: "string", description: "Supporting evidence for a learned_pattern (what you've seen)." },
        role_name: { type: "string", description: "Optional role this is about." },
        expires_in_days: { type: "number", description: "For temporary_context — when it should stop loading." },
      },
      required: ["type", "content"],
    },
  },
  {
    name: "get_memories",
    description: "Read/search long-term memory (identity, learned_pattern, temporary_context). Use to answer 'what do you know/remember about me / my goals / my patterns'. Operating rules live separately (they're always in your context already).",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["identity", "learned_pattern", "temporary_context"] },
        query: { type: "string" },
      },
    },
  },
  {
    name: "manage_memory",
    description: "Revise or remove a stored memory (find it by query). action=update to correct it (e.g. raise/lower a pattern's confidence, fix the content); action=archive to forget it. Use when she corrects a remembered fact or a pattern no longer holds. Undoable.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["update", "archive"] },
        query: { type: "string" },
        content: { type: "string" },
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        evidence: { type: "string" },
      },
      required: ["action", "query"],
    },
  },
  {
    name: "search_conversations",
    description: "Search the conversation archive (past messages — stored but not active memory). Use for 'when did we talk about…', 'what did I say about…', recovering past discussion not promoted to memory.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
  {
    name: "get_workflow_state",
    description: "Read the active guided-workflow state (process memory) — e.g. a recalibration in progress. Call this when resuming any long, multi-step process so you know exactly where you left off instead of guessing from the conversation. The active workflow is also shown at the top of your context.",
    input_schema: { type: "object", properties: { kind: { type: "string" } } },
  },
  {
    name: "start_workflow",
    description: "Begin a guided multi-step workflow whose progress must survive a chat refresh (e.g. kind='recalibration'). If one is already active it resumes instead of duplicating. Use when she enters a structured process like recalibration.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "e.g. 'recalibration'" },
        state: { type: "object", description: "Optional initial state (rolesRemaining, etc.)." },
      },
      required: ["kind"],
    },
  },
  {
    name: "update_workflow_state",
    description: "Save progress on the active workflow (merges into its state). Record things like rolesCompleted, rolesRemaining, summariesPerRole, projectsIdentified, crossroadsIdentified, memoriesProposed, unresolvedQuestions — as you go, not just at the end. Set complete=true when the whole process is done.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        patch: { type: "object", description: "Fields to merge into the workflow state." },
        complete: { type: "boolean" },
      },
      required: ["patch"],
    },
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
    description: "Fetch the user's current active Todoist tasks live (read-only), grouped by list. Always current.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "sync_todoist",
    description:
      "Force a full Todoist sync NOW to reconcile the Compass task mirror (imports new tasks, closes ones deleted/completed in Todoist). Use when she asks to refresh/verify/re-sync tasks, or right after she's changed things in Todoist.",
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

  if (name === "answer_about") {
    return j(await gatherAbout(input.topic as string | undefined));
  }

  if (name === "get_or_generate_briefing") {
    let briefing = input.regenerate ? await generateBriefing() : await getOrCreateTodaysBriefing();
    if (input.regenerate) {
      // Force a fresh voiced briefing too.
      await db.update(briefingsTable).set({ scoutBriefing: null }).where(eq(briefingsTable.id, briefing.id));
      briefing = { ...briefing, scoutBriefing: null };
    }
    const focus = await focusRoleName(briefing.focusRoleId, roles);
    return ensureScoutBriefing(briefing, focus);
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

  if (name === "get_compass_overview") {
    return j({ ok: true, ...(await getCompassOverview()) });
  }

  if (name === "manage_role") {
    const res = await manageRole({
      action: input.action as "create" | "update" | "archive",
      roleName: input.role_name as string | undefined,
      name: input.name as string | undefined,
      importance: input.importance as string | undefined,
      status: input.status as string | undefined,
      reason: input.reason as string | undefined,
      description: input.description as string | undefined,
      mission: input.mission as string | undefined,
      desiredState: input.desired_state as string | undefined,
      warningSigns: input.warning_signs as string | undefined,
      maintenanceMinimum: input.maintenance_minimum as string | undefined,
      conversationId,
    });
    return j(res);
  }

  if (name === "manage_project") {
    const res = await manageProject({
      action: input.action as "create" | "update" | "archive",
      projectName: input.project_name as string | undefined,
      name: input.name as string | undefined,
      roleName: input.role_name as string | undefined,
      status: input.status as string | undefined,
      description: input.description as string | undefined,
      desiredOutcome: input.desired_outcome as string | undefined,
      conversationId,
    });
    return j(res);
  }

  if (name === "search_crossroads") {
    return j({ ok: true, crossroads: await listCrossroads(input.query as string | undefined) });
  }

  if (name === "get_crossroad") {
    return j(await getCrossroadDetail(input.query as string));
  }

  if (name === "manage_crossroad") {
    return j(
      await manageCrossroad({
        action: input.action as "create" | "update" | "archive",
        query: input.query as string | undefined,
        title: input.title as string | undefined,
        description: input.description as string | undefined,
        status: input.status as string | undefined,
        currentLeaning: input.current_leaning as string | undefined,
        unresolvedConcerns: input.unresolved_concerns as string | undefined,
        whatChanged: input.what_changed as string | undefined,
        reasoning: input.reasoning as string | undefined,
        conversationId,
      })
    );
  }

  if (name === "record_observation") {
    return j(
      await recordObservation({
        summary: input.summary as string,
        detail: input.detail as string | undefined,
        roleName: input.role_name as string | undefined,
        severity: input.severity as string | undefined,
        conversationId,
      })
    );
  }

  if (name === "get_observations") {
    return j({ ok: true, observations: await listObservations(input.query as string | undefined) });
  }

  if (name === "scan_for_observations") {
    const { runObservationPass } = await import("./observation-engine");
    const res = await runObservationPass({ force: true });
    const observations = await listObservations();
    return j({ ok: true, ...res, observations });
  }

  if (name === "get_activity") {
    return j({ ok: true, activity: await listActivity(input.query as string | undefined, (input.limit as number) ?? 20) });
  }

  if (name === "get_checkins") {
    return j({ ok: true, checkins: await listCheckins((input.limit as number) ?? 10) });
  }

  if (name === "get_ideas") {
    return j({ ok: true, ideas: await listIdeas(input.query as string | undefined) });
  }

  if (name === "manage_idea") {
    return j(
      await manageIdea({
        action: input.action as "update" | "archive",
        query: input.query as string,
        title: input.title as string | undefined,
        status: input.status as string | undefined,
        conversationId,
      })
    );
  }

  if (name === "add_working_agreement") {
    const { summary } = await addWorkingAgreement({
      text: input.text as string,
      category: (input.category as string) ?? "behavior",
      conversationId,
    });
    return j({ ok: true, summary });
  }

  if (name === "promote_memory") {
    const role = input.role_name ? matchRole(input.role_name as string, roles) : null;
    const days = input.expires_in_days as number | undefined;
    const expiresAt = days != null ? new Date(Date.now() + days * 24 * 60 * 60 * 1000) : null;
    const res = await promoteMemory({
      type: input.type as "identity" | "operating_rule" | "learned_pattern" | "temporary_context",
      content: input.content as string,
      why: (input.why as string) ?? null,
      confidence: (input.confidence as "low" | "medium" | "high") ?? null,
      evidence: (input.evidence as string) ?? null,
      role,
      expiresAt,
      conversationId,
    });
    return j({ ok: true, ...res });
  }

  if (name === "get_memories") {
    return j({
      ok: true,
      memories: await listMemories({
        type: input.type as "identity" | "learned_pattern" | "temporary_context" | undefined,
        query: input.query as string | undefined,
      }),
    });
  }

  if (name === "manage_memory") {
    const res = await manageMemory({
      action: input.action as "update" | "archive",
      query: input.query as string,
      content: input.content as string | undefined,
      confidence: (input.confidence as "low" | "medium" | "high") ?? null,
      evidence: (input.evidence as string) ?? null,
      conversationId,
    });
    return j(res);
  }

  if (name === "search_conversations") {
    return j({ ok: true, results: await searchConversations(input.query as string, (input.limit as number) ?? 12) });
  }

  if (name === "get_workflow_state") {
    return j({ ok: true, workflow: await getActiveWorkflow(input.kind as string | undefined) });
  }

  if (name === "start_workflow") {
    return j(await startWorkflow({ kind: input.kind as string, state: input.state as Record<string, unknown> | undefined, conversationId }));
  }

  if (name === "update_workflow_state") {
    return j(await updateWorkflowState({
      kind: input.kind as string | undefined,
      patch: (input.patch as Record<string, unknown>) ?? {},
      complete: input.complete as boolean | undefined,
      conversationId,
    }));
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

  if (name === "sync_todoist") {
    const { syncTodoist, todoistEnabled } = await import("./integrations/todoist");
    if (!todoistEnabled()) return j({ ok: false, error: "Todoist not connected." });
    try {
      const result = await syncTodoist();
      return j({ ok: true, ...result });
    } catch (err) {
      return j({ ok: false, error: err instanceof Error ? err.message : "Sync failed" });
    }
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

const BRIEFING_SYSTEM = `${SCOUT_VOICE}

You are writing Selena's morning briefing. This is your JUDGMENT, not a report. Imagine you have 30 seconds with her this morning — what do you actually say?

Default shape (a guide, not a template — vary it with what's real today):
1) The one primary focus.
2) One thing you're watching.
3) One practical action or reminder.

Hard rules:
- 3 to 5 SHORT paragraphs. Plain, warm, direct — a message from a friend who's seen everything, not a dashboard.
- Have an opinion. Briefly say why the focus is the focus when it helps.
- Weave in a Crossroad or Observation ONLY when genuinely relevant — don't force them.
- If it's honestly a quiet, ordinary day, say so ("nothing unusual today") — that's a valid briefing.
- NEVER list metrics, enumerate observations, or summarize every source. No "3 tasks due, 2 observations." No manufactured urgency. No motivational-poster language.
- Follow her working agreements.

She should finish reading in under 30 seconds and immediately know: what matters most, what you're watching, and what deserves attention today.`;

/** Generate Scout's voiced morning briefing — his judgment across all sources. */
export async function generateScoutBriefing(): Promise<string> {
  const client = new Anthropic();
  const lines: string[] = [];

  const scored = await scoreRoles();
  lines.push("ROLES (most-needing-attention first):");
  for (const s of scored.slice(0, 8)) {
    const bits = [`importance ${s.role.importanceLevel}`, `${s.daysSinceAttention ?? "?"}d since attention`, `${s.openTaskCount} open tasks`];
    if (s.reasons[0]) bits.push(`top signal: ${s.reasons[0].label}`);
    lines.push(`- ${s.role.name}: ${bits.join(", ")}`);
  }

  const observations = await listObservations();
  if (observations.length) {
    lines.push("\nOPEN OBSERVATIONS (patterns you've already noticed):");
    observations.slice(0, 6).forEach((o) => lines.push(`- ${o.summary}${o.detail ? ` — ${o.detail}` : ""}`));
  }

  const crossroads = await listCrossroads();
  if (crossroads.length) {
    lines.push("\nOPEN CROSSROADS (recurring decisions):");
    crossroads.slice(0, 6).forEach((c) => lines.push(`- "${c.title}" leaning ${c.currentLeaning ?? "?"}, revisited ${c.revisitCount}×${c.unresolvedConcerns ? `; open: ${c.unresolvedConcerns}` : ""}`));
  }

  try {
    const { calendarEnabled, listTodaysEvents, formatEvents } = await import("./integrations/google-calendar");
    if (calendarEnabled()) {
      const events = await listTodaysEvents();
      lines.push(`\nTODAY'S CALENDAR:\n${formatEvents(events)}`);
    }
  } catch {
    /* optional */
  }

  // Tasks due today + overdue.
  const { start, end } = startEndOfToday();
  const open = await db.select().from(tasksTable).where(eq(tasksTable.status, "open"));
  const roleNm = new Map(scored.map((s) => [s.role.id, s.role.name]));
  const dueToday = open.filter((t) => t.dueDate && new Date(t.dueDate) >= start && new Date(t.dueDate) <= end);
  const overdue = open.filter((t) => t.dueDate && new Date(t.dueDate) < start);
  if (dueToday.length) lines.push(`\nDUE TODAY: ${dueToday.slice(0, 8).map((t) => t.title).join("; ")}`);
  if (overdue.length) lines.push(`\nOVERDUE: ${overdue.slice(0, 8).map((t) => `${t.title} (${t.roleId ? roleNm.get(t.roleId) ?? "?" : "no role"})`).join("; ")}`);

  const checkins = await listCheckins(2);
  if (checkins.length) {
    lines.push("\nRECENT CHECK-INS:");
    checkins.forEach((c) => lines.push(`- ${formatDate(c.date)}: energy ${c.energy ?? "?"}, overwhelm ${c.overwhelm ?? "?"}${c.notes ? ` — ${c.notes}` : ""}`));
  }

  try {
    const { gmailConfigured, listEmails } = await import("./integrations/gmail");
    if (gmailConfigured()) {
      const unread = await listEmails("is:unread newer_than:7d", 25);
      const byLabel = new Map<string, number>();
      for (const e of unread) for (const l of e.labels.length ? e.labels : ["(unlabeled)"]) byLabel.set(l, (byLabel.get(l) ?? 0) + 1);
      if (unread.length) lines.push(`\nUNREAD EMAIL (7d, by label): ${[...byLabel.entries()].map(([l, n]) => `${l}:${n}`).join(", ")}`);
    }
  } catch {
    /* optional */
  }

  const agreements = await db.select().from(agreementsTable).where(eq(agreementsTable.status, "active"));
  if (agreements.length) {
    lines.push("\nWORKING AGREEMENTS (how she wants you to operate):");
    agreements.forEach((a) => lines.push(`- ${a.text}`));
  }

  // Recent conversation flavor.
  const [conv] = await db.select().from(conversationsTable).orderBy(desc(conversationsTable.updatedAt)).limit(1);
  if (conv) {
    const recent = await db.select().from(messagesTable).where(eq(messagesTable.conversationId, conv.id)).orderBy(desc(messagesTable.createdAt)).limit(6);
    if (recent.length) {
      lines.push("\nRECENT CONVERSATION (newest first):");
      recent.forEach((m) => lines.push(`- ${m.role === "user" ? "Selena" : "Scout"}: ${m.content.slice(0, 160)}`));
    }
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 900,
    thinking: { type: "disabled" },
    system: BRIEFING_SYSTEM,
    messages: [{ role: "user", content: `Today is ${formatDate(new Date())}. Here's the full picture:\n\n${lines.join("\n")}\n\nWrite the briefing.` }],
  });
  return response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
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

  // Generous cap: cross-source synthesis can read many tools, then act + answer.
  for (let i = 0; i < 12; i++) {
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
