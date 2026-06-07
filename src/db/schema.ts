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
