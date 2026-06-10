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
  getOrCreateTodaysBriefing,
  getLatestBriefing,
  generateBriefing,
  briefingToText,
} from "./briefing";

export type ChiefResponse = {
  content: string;
  metadata: Record<string, unknown>;
};

async function activeRoles(): Promise<Role[]> {
  return db.select().from(rolesTable).where(isNull(rolesTable.archivedAt));
}

/** Find a role mentioned anywhere in the text by name (case-insensitive). */
function matchRole(text: string, roles: Role[]): Role | null {
  const lower = text.toLowerCase();
  // Longest names first so "House Manager" wins over a stray "house".
  const sorted = [...roles].sort((a, b) => b.name.length - a.name.length);
  for (const r of sorted) {
    if (lower.includes(r.name.toLowerCase())) return r;
  }
  return null;
}

async function focusRoleName(focusRoleId: string | null | undefined): Promise<string | null> {
  if (!focusRoleId) return null;
  const [r] = await db.select().from(rolesTable).where(eq(rolesTable.id, focusRoleId)).limit(1);
  return r?.name ?? null;
}

/* ------------------------------- Intents -------------------------------- */

function isBriefingRequest(t: string): boolean {
  return /(what'?s on tap|on tap today|brief me|today'?s briefing|what should i (do|focus)|plan( for)? (my|the) day)/i.test(
    t
  );
}

function isWhyQuestion(t: string): boolean {
  const s = t.trim().toLowerCase();
  return (
    s === "why" ||
    s === "why?" ||
    /^why\b/.test(s) ||
    /why (are|is|this|that|are you|did you|would i)/.test(s) ||
    /explain (your|the) (reasoning|recommendation)/.test(s)
  );
}

function isOverwhelmed(t: string): boolean {
  return /(overwhelmed|too much|drowning|can'?t keep up|burn(t|ed) out|exhausted|spread too thin)/i.test(
    t
  );
}

function isIgnoreQuestion(t: string): boolean {
  return /(what can i ignore|safe to ignore|what can wait|what should i drop|skip today)/i.test(t);
}

function parsePrefixed(t: string, prefixes: string[]): string | null {
  const trimmed = t.trim();
  for (const p of prefixes) {
    const re = new RegExp(`^${p}\\s*[:\\-]?\\s*`, "i");
    if (re.test(trimmed)) {
      return trimmed.replace(re, "").trim();
    }
  }
  return null;
}

function isPushback(t: string): boolean {
  return /(don'?t|do not|really don'?t)\s+want to (work on|deal with|do|focus on)|not in the mood for|skip|avoid/i.test(
    t
  );
}

/* ------------------------------- Engine --------------------------------- */

/**
 * Top-level entry point. Uses the real AI layer when an API key is configured,
 * and falls back to the deterministic rule-based engine otherwise (or if the
 * AI call errors). Either way the briefing/scoring engine is the backbone.
 */
export async function generateChiefResponse(
  userText: string,
  history: { role: "user" | "chief_of_staff" | "system"; content: string }[] = [],
  conversationId: string | null = null,
  image?: { data: string; mediaType: string }
): Promise<ChiefResponse> {
  const { aiEnabled, generateAIResponse, fastPath } = await import("./ai");
  if (aiEnabled()) {
    try {
      // Usefulness per second: trivial/simple requests skip the heavy context +
      // reasoning path. Returns null when the request needs the full treatment.
      const fast = await fastPath(userText, history, conversationId, image);
      if (fast) return fast;
      return await generateAIResponse(userText, history, conversationId, image);
    } catch (err) {
      console.error("AI layer failed, falling back to rules:", err);
      if (image) {
        return { content: "I can't look at images right now — try again in a bit.", metadata: { engine: "rules", imageUnsupported: true } };
      }
      const fallback = await generateRuleBasedResponse(userText);
      return {
        content: fallback.content,
        metadata: { ...fallback.metadata, engine: "rules", aiFallback: true },
      };
    }
  }
  const res = await generateRuleBasedResponse(userText);
  return { content: res.content, metadata: { ...res.metadata, engine: "rules" } };
}

/** Deterministic, no-AI response logic. Always available; used as the fallback. */
export async function generateRuleBasedResponse(userText: string): Promise<ChiefResponse> {
  const text = userText.trim();
  const roles = await activeRoles();

  // 1) Idea capture.
  const ideaBody = parsePrefixed(text, ["add idea", "idea", "capture idea", "remember"]);
  if (ideaBody) {
    const role = matchRole(ideaBody, roles);
    const [idea] = await db
      .insert(ideasTable)
      .values({ title: ideaBody.slice(0, 200), notes: ideaBody, roleId: role?.id ?? null, status: "captured" })
      .returning();
    return {
      content: `Captured. Filed "${idea.title}" as an idea${
        role ? ` under ${role.name}` : " (no role attached)"
      }. It'll resurface — you don't have to act on it now.`,
      metadata: { intent: "capture_idea", ideaId: idea.id, roleId: role?.id ?? null },
    };
  }

  // 2) Task capture.
  const taskBody = parsePrefixed(text, ["add task", "task", "todo", "to-do", "remind me to"]);
  if (taskBody) {
    const role = matchRole(taskBody, roles);
    let project = null;
    if (role) {
      const projs = await db
        .select()
        .from(projectsTable)
        .where(and(eq(projectsTable.roleId, role.id), eq(projectsTable.status, "active")));
      project = projs.find((p) => taskBody.toLowerCase().includes(p.name.toLowerCase())) ?? null;
    }
    const [task] = await db
      .insert(tasksTable)
      .values({
        title: taskBody.slice(0, 200),
        roleId: role?.id ?? null,
        projectId: project?.id ?? null,
        status: "open",
        priority: "medium",
      })
      .returning();

    if (!role) {
      return {
        content: `Added "${task.title}". Which role does this belong to — ${roles
          .map((r) => r.name)
          .join(", ")}? Reply and I'll file it. Leaving it unassigned for now.`,
        metadata: { intent: "capture_task", taskId: task.id, needsRole: true },
      };
    }
    return {
      content: `Added "${task.title}" under ${role.name}${
        project ? ` › ${project.name}` : ""
      }. Medium priority, no due date — tell me if either should change.`,
      metadata: { intent: "capture_task", taskId: task.id, roleId: role.id, projectId: project?.id ?? null },
    };
  }

  // 3) "What's on tap today?" → briefing.
  if (isBriefingRequest(text)) {
    const briefing = await getOrCreateTodaysBriefing();
    const name = await focusRoleName(briefing.focusRoleId);
    return {
      content: briefingToText(briefing, name),
      metadata: { intent: "briefing", briefingId: briefing.id, focusRoleId: briefing.focusRoleId },
    };
  }

  // 4) "Why?" → reasoning from latest briefing.
  if (isWhyQuestion(text)) {
    const briefing = await getLatestBriefing();
    if (!briefing) {
      return {
        content: `I haven't made a recommendation yet. Ask "what's on tap today?" and I'll give you one — with the reasoning.`,
        metadata: { intent: "why", hasBriefing: false },
      };
    }
    const name = await focusRoleName(briefing.focusRoleId);
    const parts: string[] = [];
    parts.push(`Here's the reasoning behind ${name ? `focusing on ${name}` : "the latest briefing"}:`);
    if (briefing.whyThis) parts.push(`\n**Why this:**\n${briefing.whyThis}`);
    if (briefing.whyNow) parts.push(`\n**Why now:** ${briefing.whyNow}`);
    if (briefing.whyNotOtherRoles) parts.push(`\n**Why not the others:**\n${briefing.whyNotOtherRoles}`);
    return {
      content: parts.join("\n"),
      metadata: { intent: "why", briefingId: briefing.id },
    };
  }

  // 5) Overwhelm.
  if (isOverwhelmed(text)) {
    const briefing = await getOrCreateTodaysBriefing();
    const name = await focusRoleName(briefing.focusRoleId);
    return {
      content: [
        `Okay. Let's shrink this.`,
        ``,
        `You don't have to handle everything — just one thing. Today that's **${name ?? "your top role"}**.`,
        ``,
        `**Do only this:** ${briefing.next15MinuteAction ?? "Pick the smallest next step and do 15 minutes."}`,
        ``,
        `Everything else is allowed to wait. ${briefing.safeToIgnore ?? ""}`.trim(),
      ].join("\n"),
      metadata: { intent: "overwhelmed", briefingId: briefing.id },
    };
  }

  // 6) "What can I ignore?"
  if (isIgnoreQuestion(text)) {
    const briefing = await getOrCreateTodaysBriefing();
    return {
      content: `**Safe to ignore today:** ${briefing.safeToIgnore ?? "Focus only on the top role; the rest can wait."}`,
      metadata: { intent: "ignore", briefingId: briefing.id },
    };
  }

  // 7) Pushback on a role recommendation.
  if (isPushback(text)) {
    const role = matchRole(text, roles);
    if (role) {
      // Keep the role flagged: do NOT clear its attention. Offer a smaller step.
      const [smallTask] = await db
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.roleId, role.id), eq(tasksTable.status, "open")))
        .orderBy(desc(tasksTable.avoidanceCount))
        .limit(1);

      // Bump avoidance on the most-skipped open task so the pattern is tracked.
      if (smallTask) {
        await db
          .update(tasksTable)
          .set({ avoidanceCount: smallTask.avoidanceCount + 1, updatedAt: new Date() })
          .where(eq(tasksTable.id, smallTask.id));
      }

      return {
        content: [
          `Fair — you don't have to go deep on ${role.name} today.`,
          ``,
          smallTask
            ? `But I'm keeping it flagged, and I noted you skipped it (now ${smallTask.avoidanceCount + 1}×). Lower-friction option: just 5 minutes on "${smallTask.title}", or even a 2-line note about what's blocking you.`
            : `But I'm keeping it flagged. Lower-friction option: spend 5 minutes deciding the single smallest next step — no need to actually do it yet.`,
          ``,
          `If you skip it again I'll keep surfacing it, because that's exactly the pattern this is meant to catch.`,
        ].join("\n"),
        metadata: { intent: "pushback", roleId: role.id, flaggedKept: true },
      };
    }
    return {
      content: `Got it — which role are you pushing back on? I'll keep it flagged either way and find you a smaller step.`,
      metadata: { intent: "pushback", needsRole: true },
    };
  }

  // 8) Generate / regenerate briefing explicitly.
  if (/regenerate|new briefing|refresh briefing/i.test(text)) {
    const briefing = await generateBriefing();
    const name = await focusRoleName(briefing.focusRoleId);
    return {
      content: `Fresh briefing generated.\n\n${briefingToText(briefing, name)}`,
      metadata: { intent: "regenerate_briefing", briefingId: briefing.id },
    };
  }

  // 9) Fallback — stay useful, point to the one thing that matters.
  return {
    content: [
      `I'm your Chief of Staff — I track your roles and tell you where attention should go.`,
      ``,
      `Try:`,
      `• "What's on tap today?" — today's focus + reasoning`,
      `• "I'm overwhelmed" — I'll shrink it to one thing`,
      `• "idea: ..." or "task: ..." — capture something`,
      `• "I don't want to work on Founder today" — push back, I'll adapt`,
      `• "why?" — the reasoning behind a recommendation`,
    ].join("\n"),
    metadata: { intent: "fallback" },
  };
}
