"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import {
  db,
  roles,
  projects,
  tasks,
  ideas,
  decisions,
  checkins,
  checkinRoleScores,
  roleAttentionEvents,
  proposedUpdates,
  insights,
  briefings,
  workingAgreements,
  memories,
} from "@/db";
import { generateBriefing } from "@/lib/briefing";
import { todayStr } from "@/lib/dates";

/* helpers */
function str(fd: FormData, k: string): string {
  return (fd.get(k) ?? "").toString().trim();
}
function strOrNull(fd: FormData, k: string): string | null {
  const v = str(fd, k);
  return v === "" ? null : v;
}
function intOrNull(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v === "") return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}
function dateOrNull(fd: FormData, k: string): Date | null {
  const v = str(fd, k);
  return v === "" ? null : new Date(v);
}

/* ------------------------------- Roles -------------------------------- */

export async function createRole(fd: FormData) {
  await db.insert(roles).values({
    name: str(fd, "name"),
    description: strOrNull(fd, "description"),
    mission: strOrNull(fd, "mission"),
    desiredState: strOrNull(fd, "desiredState"),
    warningSigns: strOrNull(fd, "warningSigns"),
    maintenanceMinimum: strOrNull(fd, "maintenanceMinimum"),
    importanceLevel: (str(fd, "importanceLevel") || "medium") as never,
    currentStatus: (str(fd, "currentStatus") || "maintaining") as never,
  });
  revalidatePath("/roles");
  revalidatePath("/dashboard");
}

export async function updateRole(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(roles)
    .set({
      name: str(fd, "name"),
      description: strOrNull(fd, "description"),
      mission: strOrNull(fd, "mission"),
      desiredState: strOrNull(fd, "desiredState"),
      warningSigns: strOrNull(fd, "warningSigns"),
      maintenanceMinimum: strOrNull(fd, "maintenanceMinimum"),
      importanceLevel: (str(fd, "importanceLevel") || "medium") as never,
      currentStatus: (str(fd, "currentStatus") || "maintaining") as never,
      updatedAt: new Date(),
    })
    .where(eq(roles.id, id));
  revalidatePath("/roles");
  revalidatePath(`/roles/${id}`);
  revalidatePath("/dashboard");
}

export async function archiveRole(fd: FormData) {
  const id = str(fd, "id");
  await db.update(roles).set({ archivedAt: new Date() }).where(eq(roles.id, id));
  revalidatePath("/roles");
  revalidatePath("/dashboard");
}

export async function markRoleAttention(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(roles)
    .set({ lastMeaningfulAttentionAt: new Date(), updatedAt: new Date() })
    .where(eq(roles.id, id));
  revalidatePath("/roles");
  revalidatePath(`/roles/${id}`);
}

/**
 * Log a typed attention event for a role (backstage manual entry).
 * In Phase 2 the Chief of Staff creates these automatically from chat; this
 * form exists so the mechanism is testable and manually correctable.
 */
export async function logAttentionEvent(fd: FormData) {
  const roleId = str(fd, "roleId");
  await db.insert(roleAttentionEvents).values({
    roleId,
    projectId: strOrNull(fd, "projectId"),
    attentionType: (str(fd, "attentionType") || "focused_work") as never,
    durationMinutes: intOrNull(fd, "durationMinutes"),
    notes: strOrNull(fd, "notes"),
    source: "manual",
  });
  // Logging attention refreshes the role's meaningful-attention marker.
  await db
    .update(roles)
    .set({ lastMeaningfulAttentionAt: new Date(), updatedAt: new Date() })
    .where(eq(roles.id, roleId));
  revalidatePath(`/roles/${roleId}`);
  revalidatePath("/roles");
  revalidatePath("/dashboard");
  revalidatePath("/briefing");
}

/* ------------------------------ Projects ------------------------------ */

export async function createProject(fd: FormData) {
  await db.insert(projects).values({
    roleId: strOrNull(fd, "roleId"),
    name: str(fd, "name"),
    description: strOrNull(fd, "description"),
    desiredOutcome: strOrNull(fd, "desiredOutcome"),
    status: (str(fd, "status") || "active") as never,
    strategicImportance: (str(fd, "strategicImportance") || "medium") as never,
    energyRequired: (str(fd, "energyRequired") || "medium") as never,
    deadline: dateOrNull(fd, "deadline"),
  });
  revalidatePath("/projects");
  revalidatePath("/dashboard");
}

export async function updateProject(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(projects)
    .set({
      roleId: strOrNull(fd, "roleId"),
      name: str(fd, "name"),
      description: strOrNull(fd, "description"),
      desiredOutcome: strOrNull(fd, "desiredOutcome"),
      status: (str(fd, "status") || "active") as never,
      strategicImportance: (str(fd, "strategicImportance") || "medium") as never,
      energyRequired: (str(fd, "energyRequired") || "medium") as never,
      deadline: dateOrNull(fd, "deadline"),
      updatedAt: new Date(),
    })
    .where(eq(projects.id, id));
  revalidatePath("/projects");
}

export async function markProjectProgress(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(projects)
    .set({ lastMeaningfulProgressAt: new Date(), updatedAt: new Date() })
    .where(eq(projects.id, id));
  revalidatePath("/projects");
}

export async function archiveProject(fd: FormData) {
  const id = str(fd, "id");
  await db.update(projects).set({ status: "archived", updatedAt: new Date() }).where(eq(projects.id, id));
  revalidatePath("/projects");
}

/* -------------------------------- Tasks ------------------------------- */

export async function createTask(fd: FormData) {
  await db.insert(tasks).values({
    roleId: strOrNull(fd, "roleId"),
    projectId: strOrNull(fd, "projectId"),
    title: str(fd, "title"),
    notes: strOrNull(fd, "notes"),
    status: (str(fd, "status") || "open") as never,
    priority: (str(fd, "priority") || "medium") as never,
    dueDate: dateOrNull(fd, "dueDate"),
    estimatedMinutes: intOrNull(fd, "estimatedMinutes"),
  });
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}

export async function updateTask(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(tasks)
    .set({
      roleId: strOrNull(fd, "roleId"),
      projectId: strOrNull(fd, "projectId"),
      title: str(fd, "title"),
      notes: strOrNull(fd, "notes"),
      status: (str(fd, "status") || "open") as never,
      priority: (str(fd, "priority") || "medium") as never,
      dueDate: dateOrNull(fd, "dueDate"),
      estimatedMinutes: intOrNull(fd, "estimatedMinutes"),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, id));
  revalidatePath("/tasks");
}

export async function completeTask(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(tasks)
    .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(tasks.id, id));
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}

export async function archiveTask(fd: FormData) {
  const id = str(fd, "id");
  await db.update(tasks).set({ status: "archived", updatedAt: new Date() }).where(eq(tasks.id, id));
  revalidatePath("/tasks");
}

/* -------------------------------- Ideas ------------------------------- */

export async function createIdea(fd: FormData) {
  await db.insert(ideas).values({
    roleId: strOrNull(fd, "roleId"),
    title: str(fd, "title"),
    notes: strOrNull(fd, "notes"),
    status: (str(fd, "status") || "captured") as never,
    resurfacingFrequency: strOrNull(fd, "resurfacingFrequency"),
  });
  revalidatePath("/ideas");
}

export async function updateIdea(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(ideas)
    .set({
      roleId: strOrNull(fd, "roleId"),
      title: str(fd, "title"),
      notes: strOrNull(fd, "notes"),
      status: (str(fd, "status") || "captured") as never,
      resurfacingFrequency: strOrNull(fd, "resurfacingFrequency"),
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, id));
  revalidatePath("/ideas");
}

export async function archiveIdea(fd: FormData) {
  const id = str(fd, "id");
  await db.update(ideas).set({ status: "archived", updatedAt: new Date() }).where(eq(ideas.id, id));
  revalidatePath("/ideas");
}

/* ------------------------------ Decisions ----------------------------- */

export async function createDecision(fd: FormData) {
  await db.insert(decisions).values({
    title: str(fd, "title"),
    description: strOrNull(fd, "description"),
    status: (str(fd, "status") || "open") as never,
    decision: strOrNull(fd, "decision"),
    reasoning: strOrNull(fd, "reasoning"),
    revisitDate: dateOrNull(fd, "revisitDate"),
  });
  revalidatePath("/crossroads");
}

export async function updateDecision(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(decisions)
    .set({
      title: str(fd, "title"),
      description: strOrNull(fd, "description"),
      status: (str(fd, "status") || "open") as never,
      decision: strOrNull(fd, "decision"),
      reasoning: strOrNull(fd, "reasoning"),
      revisitDate: dateOrNull(fd, "revisitDate"),
      updatedAt: new Date(),
    })
    .where(eq(decisions.id, id));
  revalidatePath("/crossroads");
}

export async function archiveDecision(fd: FormData) {
  const id = str(fd, "id");
  await db.update(decisions).set({ status: "archived", updatedAt: new Date() }).where(eq(decisions.id, id));
  revalidatePath("/crossroads");
}

/* ------------------------------ Check-ins ----------------------------- */

export async function createCheckin(fd: FormData) {
  const [checkin] = await db
    .insert(checkins)
    .values({
      checkinDate: str(fd, "checkinDate") || todayStr(),
      energyLevel: intOrNull(fd, "energyLevel"),
      overwhelmLevel: intOrNull(fd, "overwhelmLevel"),
      notes: strOrNull(fd, "notes"),
    })
    .returning();

  // Per-role scores arrive as health_<roleId>, win_<roleId>, etc.
  const roleIds = new Set<string>();
  for (const key of fd.keys()) {
    const m = key.match(/^health_(.+)$/);
    if (m) roleIds.add(m[1]);
  }

  for (const roleId of roleIds) {
    const health = intOrNull(fd, `health_${roleId}`);
    const win = strOrNull(fd, `win_${roleId}`);
    const concern = strOrNull(fd, `concern_${roleId}`);
    const avoided = strOrNull(fd, `avoided_${roleId}`);
    const notes = strOrNull(fd, `notes_${roleId}`);
    if (health == null && !win && !concern && !avoided && !notes) continue;
    await db.insert(checkinRoleScores).values({
      checkinId: checkin.id,
      roleId,
      healthScore: health,
      biggestWin: win,
      biggestConcern: concern,
      avoidedItem: avoided,
      notes,
    });
  }

  revalidatePath("/checkin");
  revalidatePath("/dashboard");
}

/* ------------------------------ Briefing ------------------------------ */

export async function generateBriefingAction() {
  // Refresh today's briefing (clear + regenerate) so it stays singular/current.
  const today = todayStr();
  await db.delete(briefings).where(eq(briefings.briefingDate, today));
  await generateBriefing(today);
  revalidatePath("/briefing");
  revalidatePath("/dashboard");
}

/* ---------------------------- Integrations ---------------------------- */

export async function syncTodoistAction() {
  const { syncTodoist } = await import("@/lib/integrations/todoist");
  await syncTodoist();
  revalidatePath("/integrations");
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}

/* ----------------------- Review & Observations ------------------------ */

export async function acceptProposal(fd: FormData) {
  const id = str(fd, "id");
  // Phase 2: low-confidence proposals are lightweight suggestions; accepting
  // acknowledges them. (Structured auto-apply lands with the Phase 3 queue.)
  await db
    .update(proposedUpdates)
    .set({ status: "applied", decidedAt: new Date() })
    .where(eq(proposedUpdates.id, id));
  revalidatePath("/review");
}

export async function rejectProposal(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(proposedUpdates)
    .set({ status: "rejected", decidedAt: new Date() })
    .where(eq(proposedUpdates.id, id));
  revalidatePath("/review");
}

export async function undoActivityAction(fd: FormData) {
  const id = str(fd, "id");
  const { undoActivity } = await import("@/lib/operator");
  await undoActivity(id);
  revalidatePath("/review");
  revalidatePath("/tasks");
  revalidatePath("/ideas");
  revalidatePath("/dashboard");
}

export async function dismissObservation(fd: FormData) {
  const id = str(fd, "id");
  await db.update(insights).set({ status: "dismissed", updatedAt: new Date() }).where(eq(insights.id, id));
  revalidatePath("/observations");
}

export async function resolveObservation(fd: FormData) {
  const id = str(fd, "id");
  await db.update(insights).set({ status: "resolved", updatedAt: new Date() }).where(eq(insights.id, id));
  revalidatePath("/observations");
}

/* ----------------------------- Weekly review ------------------------------ */

export async function regenerateWeekly() {
  const { generateWeeklyReview } = await import("@/lib/weekly-review");
  await generateWeeklyReview();
  revalidatePath("/weekly");
}

/* -------------------------------- Memory ---------------------------------- */

export async function archiveMemory(fd: FormData) {
  const id = str(fd, "id");
  await db.update(memories).set({ status: "archived", updatedAt: new Date() }).where(eq(memories.id, id));
  revalidatePath("/memory");
}

/* --------------------------- Working agreements ---------------------------- */

export async function createAgreement(fd: FormData) {
  await db.insert(workingAgreements).values({
    text: str(fd, "text"),
    category: str(fd, "category") || "behavior",
    source: "manual",
  });
  revalidatePath("/agreements");
}

export async function updateAgreement(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(workingAgreements)
    .set({ text: str(fd, "text"), category: str(fd, "category") || "behavior", updatedAt: new Date() })
    .where(eq(workingAgreements.id, id));
  revalidatePath("/agreements");
}

export async function archiveAgreement(fd: FormData) {
  const id = str(fd, "id");
  await db
    .update(workingAgreements)
    .set({ status: "archived", updatedAt: new Date() })
    .where(eq(workingAgreements.id, id));
  revalidatePath("/agreements");
}
