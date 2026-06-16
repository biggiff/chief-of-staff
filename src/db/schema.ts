import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  date,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Schema for the personal Chief of Staff app.
 *
 * Design notes:
 * - Statuses / enums are stored as plain `text` columns and constrained by
 *   TypeScript union types (below) rather than Postgres enums. This keeps
 *   migrations painless while iterating on the product model.
 * - Everything ultimately hangs off `roles` — the core organizing concept.
 */

/* ----------------------------- Shared types ----------------------------- */

export type ImportanceLevel = "low" | "medium" | "high";
export type RoleStatus =
  | "thriving"
  | "healthy"
  | "maintaining"
  | "needs_attention"
  | "critical";
export type ProjectStatus = "active" | "paused" | "completed" | "archived";
export type EnergyLevel = "low" | "medium" | "high";
export type TaskStatus = "open" | "completed" | "archived";
export type Priority = "low" | "medium" | "high";
export type IdeaStatus = "captured" | "resurfaced" | "active" | "archived";
export type DecisionStatus = "active" | "open" | "decided" | "revisiting" | "reopened" | "archived";
export type IntegrationStatus = "not_connected" | "connected" | "error";
export type MessageRole = "user" | "chief_of_staff" | "system";
export type AttentionType =
  | "focused_work"
  | "progress"
  | "planning"
  | "thinking"
  | "relationship"
  | "maintenance"
  | "rest";
export type Confidence = "high" | "medium" | "low";
export type ProposedUpdateStatus = "pending" | "applied" | "rejected" | "dismissed";
export type InsightStatus = "open" | "surfaced" | "dismissed" | "resolved";
export type MemoryType = "identity" | "learned_pattern" | "temporary_context";
export type MemoryStatus = "active" | "archived" | "superseded";
export type WorkflowStatus = "active" | "paused" | "complete";
export type ReminderStatus = "pending" | "sent" | "canceled";

/* -------------------------------- Roles -------------------------------- */

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  mission: text("mission"),
  desiredState: text("desired_state"),
  warningSigns: text("warning_signs"),
  maintenanceMinimum: text("maintenance_minimum"),
  importanceLevel: text("importance_level").$type<ImportanceLevel>().notNull().default("medium"),
  currentStatus: text("current_status").$type<RoleStatus>().notNull().default("maintaining"),
  lastMeaningfulAttentionAt: timestamp("last_meaningful_attention_at", { withTimezone: true }),
  // Per-role scoring overrides (e.g. { attentionWeights: { progress: 4 } }).
  // Null = use global defaults. This is the seam for per-role weighting later.
  scoringConfig: jsonb("scoring_config"),
  // History of significant changes (renames etc.) with reasoning:
  // [{ from, to, reason, at }]. Preserved as context for future reasoning.
  changeHistory: jsonb("change_history"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Projects ------------------------------- */

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  desiredOutcome: text("desired_outcome"),
  status: text("status").$type<ProjectStatus>().notNull().default("active"),
  strategicImportance: text("strategic_importance").$type<ImportanceLevel>().notNull().default("medium"),
  energyRequired: text("energy_required").$type<EnergyLevel>().notNull().default("medium"),
  deadline: timestamp("deadline", { withTimezone: true }),
  lastMeaningfulProgressAt: timestamp("last_meaningful_progress_at", { withTimezone: true }),
  // Provenance for synced projects (e.g. "todoist"). Null = created in-app.
  source: text("source"),
  externalId: text("external_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------- Tasks -------------------------------- */

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  notes: text("notes"),
  status: text("status").$type<TaskStatus>().notNull().default("open"),
  priority: text("priority").$type<Priority>().notNull().default("medium"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  estimatedMinutes: integer("estimated_minutes"),
  avoidanceCount: integer("avoidance_count").notNull().default(0),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // Provenance for synced tasks (e.g. "todoist"). Null = created in-app.
  source: text("source"),
  externalId: text("external_id"),
  // Raw Todoist project id this task came from (resolved to a CoS role/project
  // via todoist_project_links, not auto-created). Todoist is the source of truth.
  todoistProjectId: text("todoist_project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------- Ideas -------------------------------- */

export const ideas = pgTable("ideas", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  notes: text("notes"),
  status: text("status").$type<IdeaStatus>().notNull().default("captured"),
  resurfacingFrequency: text("resurfacing_frequency"),
  lastResurfacedAt: timestamp("last_resurfaced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Check-ins ------------------------------ */

export const checkins = pgTable("checkins", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkinDate: date("checkin_date").notNull(),
  energyLevel: integer("energy_level"),
  overwhelmLevel: integer("overwhelm_level"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const checkinRoleScores = pgTable("checkin_role_scores", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkinId: uuid("checkin_id").notNull().references(() => checkins.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  healthScore: integer("health_score"),
  statusOverride: text("status_override").$type<RoleStatus>(),
  biggestWin: text("biggest_win"),
  biggestConcern: text("biggest_concern"),
  avoidedItem: text("avoided_item"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Briefings ------------------------------ */

export const briefings = pgTable("briefings", {
  id: uuid("id").primaryKey().defaultRandom(),
  briefingDate: date("briefing_date").notNull(),
  focusRoleId: uuid("focus_role_id").references(() => roles.id, { onDelete: "set null" }),
  summary: text("summary"),
  whyThis: text("why_this"),
  whyNow: text("why_now"),
  whyNotOtherRoles: text("why_not_other_roles"),
  next15MinuteAction: text("next_15_minute_action"),
  safeToIgnore: text("safe_to_ignore"),
  avoidanceAlerts: text("avoidance_alerts"),
  // Scout-voiced home-screen copy, cached so the home doesn't call the model per load.
  scoutOpener: text("scout_opener"),
  scoutNote: text("scout_note"),
  // Scout's full voiced morning briefing (his judgment, 3-5 short paragraphs).
  scoutBriefing: text("scout_briefing"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Decisions ------------------------------ */

export const decisions = pgTable("decisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").$type<DecisionStatus>().notNull().default("open"),
  decision: text("decision"),
  reasoning: text("reasoning"),
  revisitDate: timestamp("revisit_date", { withTimezone: true }),
  // Decision tracking — recurring mental-load decisions, not one-off tasks.
  firstDiscussedAt: timestamp("first_discussed_at", { withTimezone: true }),
  latestDiscussedAt: timestamp("latest_discussed_at", { withTimezone: true }),
  revisitCount: integer("revisit_count").notNull().default(0),
  currentLeaning: text("current_leaning"),
  unresolvedConcerns: text("unresolved_concerns"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------- Integrations ---------------------------- */

export const integrations = pgTable("integrations", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull(),
  status: text("status").$type<IntegrationStatus>().notNull().default("not_connected"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  settingsJson: jsonb("settings_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ---------------------- Conversations & Messages ----------------------- */

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").$type<MessageRole>().notNull(),
  content: text("content").notNull(),
  metadataJson: jsonb("metadata_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------- Role attention events ------------------------- */

export const roleAttentionEvents = pgTable("role_attention_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  attentionType: text("attention_type").$type<AttentionType>().notNull(),
  durationMinutes: integer("duration_minutes"),
  notes: text("notes"),
  source: text("source").notNull().default("chat"), // chat | manual | inferred
  // When the activity actually happened (the real workout/event date) — a
  // first-class field, distinct from createdAt (when it was entered into Compass).
  // Lets us backlog history (e.g. 9 workouts from a screenshot) without losing the
  // timeline. Defaults to now for live logging.
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------- Proposed updates (review) ----------------------- */

export const proposedUpdates = pgTable("proposed_updates", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  summary: text("summary").notNull(),
  payloadJson: jsonb("payload_json"),
  confidence: text("confidence").$type<Confidence>().notNull().default("low"),
  status: text("status").$type<ProposedUpdateStatus>().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

/* ------------------------------ Insights ------------------------------- */

export const insights = pgTable("insights", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  summary: text("summary").notNull(),
  detail: text("detail"),
  severity: text("severity").notNull().default("info"), // info | notice | concern
  source: text("source").notNull().default("manual"), // manual | chat | engine
  status: text("status").$type<InsightStatus>().notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------------- Activity log ---------------------------- */

export const activityLog = pgTable("activity_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actionKind: text("action_kind").notNull(),
  summary: text("summary").notNull(),
  entityTable: text("entity_table"),
  entityId: text("entity_id"),
  undoPayloadJson: jsonb("undo_payload_json"),
  source: text("source").notNull().default("chat"),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  undoneAt: timestamp("undone_at", { withTimezone: true }),
});

/* --------------------- Crossroad discussion timeline ------------------- */

/**
 * One entry per time a Crossroad (decision) is discussed — the history that lets
 * Scout summarize prior conclusions and explain how the current conversation
 * differs from past ones.
 */
export const crossroadDiscussions = pgTable("crossroad_discussions", {
  id: uuid("id").primaryKey().defaultRandom(),
  decisionId: uuid("decision_id").notNull().references(() => decisions.id, { onDelete: "cascade" }),
  leaning: text("leaning"),
  concerns: text("concerns"),
  note: text("note"), // what changed / context for this discussion
  source: text("source").notNull().default("chat"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------ Working agreements --------------------------- */

/**
 * Standing instructions from the user about how Scout should operate —
 * behavioral preferences, operating rules, corrections, and lessons learned.
 * These load into Scout's context every session and shape his behavior.
 */
export const workingAgreements = pgTable("working_agreements", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  category: text("category").notNull().default("behavior"), // behavior | priority | style | correction | lesson
  status: text("status").notNull().default("active"), // active | archived
  source: text("source").notNull().default("manual"), // manual | learned
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Memories ------------------------------- */

/**
 * Tiered long-term memory (Phase 3.6). The goal is BETTER memory, not more:
 * Scout promotes only statements with durable value, classified by type.
 *
 * Tier map across Compass:
 *  - Conversation Archive → the `messages` table (stored + searchable; NOT active memory).
 *  - Operating Rules      → the `working_agreements` table (always loaded, binding).
 *  - Identity / Learned Patterns / Temporary Context → THIS table.
 *
 * Learned patterns carry `confidence` + `evidence` and are revisable/removable.
 * Temporary context carries `expiresAt` and drops out of context once expired.
 */
export const memories = pgTable("memories", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").$type<MemoryType>().notNull(), // identity | learned_pattern | temporary_context
  content: text("content").notNull(), // the memory itself, phrased durably
  whyItMatters: text("why_it_matters"), // why this was worth promoting
  confidence: text("confidence").$type<Confidence>(), // mainly for learned_pattern
  evidence: text("evidence"), // supporting evidence for a learned pattern
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }), // temporary_context only
  status: text("status").$type<MemoryStatus>().notNull().default("active"), // active | archived | superseded
  supersededById: uuid("superseded_by_id"),
  source: text("source").notNull().default("chat"), // chat | promotion | manual | engine
  changeHistory: jsonb("change_history"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ----------------------- Grocery categorization ------------------------ */

/**
 * Learned grocery placements (Phase 3.9). When Selena moves an item to a
 * different section, we remember it here so next time that item lands in the
 * right place — overriding the static dictionary and AI fallback.
 */
export const groceryPreferences = pgTable("grocery_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemKey: text("item_key").notNull(), // normalized item name (lowercased, trimmed)
  section: text("section").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Reminders ------------------------------ */

/**
 * One-shot timed reminders: "text me at 3pm to call the dentist." A frequent
 * cron (/api/reminders/tick) sends each one via the owner's channel (Telegram)
 * when it comes due. Distinct from Todoist tasks — these are nudges Scout pushes
 * to her at a wall-clock time, not items on a list.
 */
export const reminders = pgTable("reminders", {
  id: uuid("id").primaryKey().defaultRandom(),
  text: text("text").notNull(),
  remindAt: timestamp("remind_at", { withTimezone: true }).notNull(),
  status: text("status").$type<ReminderStatus>().notNull().default("pending"), // pending | sent | canceled
  source: text("source").notNull().default("chat"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});

/* ------------------------- Weekly review ------------------------------- */

/**
 * The Weekly Chief-of-Staff Briefing (Phase 3.8) — comparative, not a snapshot.
 * One row per week. `snapshot` stores the structured metrics so NEXT week can
 * diff against it; `priorities` stores this week's "attention next week" items so
 * next week can close the loop on them.
 */
export const weeklyReviews = pgTable("weekly_reviews", {
  id: uuid("id").primaryKey().defaultRandom(),
  weekOf: date("week_of").notNull(), // the review date (the Sunday it covers through)
  narrative: text("narrative").notNull(), // the voiced 5-section review
  throughline: text("throughline"),
  biggestQuestion: text("biggest_question"),
  priorities: jsonb("priorities"), // [{ item, why }] — checked for follow-through next week
  snapshot: jsonb("snapshot"), // structured metrics for next week's diff
  openedAt: timestamp("opened_at", { withTimezone: true }), // when she viewed it (for the nudge)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* --------------------- Process memory / workflow state ----------------- */

/**
 * Guided-workflow state (Phase 3.7). Long-running, multi-step processes
 * (recalibration above all) must NOT live in conversation memory — if the chat
 * refreshes, Scout has to still know exactly where he left off. One row per
 * workflow run; `state` holds the structured progress.
 */
export const workflowStates = pgTable("workflow_states", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(), // e.g. "recalibration"
  status: text("status").$type<WorkflowStatus>().notNull().default("active"), // active | paused | complete
  // { rolesCompleted, rolesRemaining, summariesPerRole, projectsIdentified,
  //   crossroadsIdentified, memoriesProposed, unresolvedQuestions, notes }
  state: jsonb("state").notNull().default({}),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/* -------------------- Todoist project mapping layer -------------------- */

export const todoistProjectLinks = pgTable("todoist_project_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  todoistProjectId: text("todoist_project_id").notNull(),
  todoistProjectName: text("todoist_project_name"),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "set null" }),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/* ------------------------------ Row types ------------------------------ */

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;
export type Idea = typeof ideas.$inferSelect;
export type NewIdea = typeof ideas.$inferInsert;
export type Checkin = typeof checkins.$inferSelect;
export type CheckinRoleScore = typeof checkinRoleScores.$inferSelect;
export type Briefing = typeof briefings.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type RoleAttentionEvent = typeof roleAttentionEvents.$inferSelect;
export type NewRoleAttentionEvent = typeof roleAttentionEvents.$inferInsert;
export type ProposedUpdate = typeof proposedUpdates.$inferSelect;
export type Insight = typeof insights.$inferSelect;
export type ActivityLog = typeof activityLog.$inferSelect;
export type TodoistProjectLink = typeof todoistProjectLinks.$inferSelect;
export type WorkingAgreement = typeof workingAgreements.$inferSelect;
export type CrossroadDiscussion = typeof crossroadDiscussions.$inferSelect;
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;
export type WorkflowState = typeof workflowStates.$inferSelect;
export type NewWorkflowState = typeof workflowStates.$inferInsert;
export type WeeklyReview = typeof weeklyReviews.$inferSelect;
export type NewWeeklyReview = typeof weeklyReviews.$inferInsert;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type GroceryPreference = typeof groceryPreferences.$inferSelect;
export type NewGroceryPreference = typeof groceryPreferences.$inferInsert;
