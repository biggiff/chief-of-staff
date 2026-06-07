import { eq } from "drizzle-orm";
import { db, roles } from "@/db";
import { PageShell, Card } from "@/components/ui";
import { getLatestBriefing, ensureScoutBriefing } from "@/lib/briefing";
import { formatDate, formatTime } from "@/lib/dates";
import GenerateButton from "./GenerateButton";

export const dynamic = "force-dynamic";

function Block({ title, body }: { title: string; body: string | null | undefined }) {
  if (!body) return null;
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1">{title}</div>
      <div className="text-sm text-neutral-800 whitespace-pre-wrap">{body}</div>
    </div>
  );
}

export default async function BriefingPage() {
  const b = await getLatestBriefing();
  let focusName: string | null = null;
  if (b?.focusRoleId) {
    const [r] = await db.select().from(roles).where(eq(roles.id, b.focusRoleId)).limit(1);
    focusName = r?.name ?? null;
  }
  // Scout's voiced judgment — generated lazily and cached on the row.
  const scoutSays = b ? await ensureScoutBriefing(b, focusName) : null;

  return (
    <PageShell
      title="Briefings"
      subtitle="Scout's read on where your attention should go today, from Compass. Refresh anytime."
      actions={<GenerateButton />}
    >
      {!b && <p className="text-sm text-neutral-500">No briefing yet. Generate one above.</p>}
      {b && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-neutral-500">
              {formatDate(b.briefingDate)}
              <span className="text-neutral-400"> · generated {formatTime(b.createdAt)}</span>
            </div>
            {focusName && (
              <div className="text-sm">
                Focus: <span className="font-semibold">{focusName}</span>
              </div>
            )}
          </div>
          {scoutSays && (
            <div className="text-[15px] leading-relaxed text-neutral-800 whitespace-pre-wrap">
              {scoutSays}
            </div>
          )}
          <details className="group">
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600 select-none">
              Reasoning
            </summary>
            <div className="mt-3 space-y-4">
              {b.summary && <p className="text-sm font-medium text-neutral-700">{b.summary}</p>}
              <div className="grid gap-4 sm:grid-cols-2">
                <Block title="Why this" body={b.whyThis} />
                <Block title="Why now" body={b.whyNow} />
                <Block title="Why not the others" body={b.whyNotOtherRoles} />
                <Block title="Next 15-minute action" body={b.next15MinuteAction} />
                <Block title="Safe to ignore" body={b.safeToIgnore} />
                <Block title="Avoidance alerts" body={b.avoidanceAlerts} />
              </div>
            </div>
          </details>
        </Card>
      )}
    </PageShell>
  );
}
