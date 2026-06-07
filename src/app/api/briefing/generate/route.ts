import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, briefings } from "@/db";
import { generateBriefing, ensureScoutBriefing } from "@/lib/briefing";
import { todayStr } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * Refresh today's briefing: clears today's existing briefing(s) and regenerates
 * from current Compass state, so "today's briefing" stays singular and current.
 */
export async function POST() {
  try {
    const today = todayStr();
    await db.delete(briefings).where(eq(briefings.briefingDate, today));
    const briefing = await generateBriefing(today);
    // Generate Scout's voiced judgment now so the page loads it instantly.
    await ensureScoutBriefing(briefing);
    return NextResponse.json({
      ok: true,
      briefingId: briefing.id,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("briefing generate failed", err);
    return NextResponse.json(
      { ok: false, error: "Couldn't generate the briefing. Please try again." },
      { status: 500 }
    );
  }
}
