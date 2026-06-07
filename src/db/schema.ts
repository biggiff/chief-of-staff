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
export type DecisionStatus = "open" | "decided" | "revisiting" | "archived";
export type IntegrationStatus = "not_connected" | "connected" | "error";
export type MessageRole = "user" | "chief_of_staff" | "system";

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
