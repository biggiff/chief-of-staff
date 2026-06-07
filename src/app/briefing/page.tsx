import { eq } from "drizzle-orm";
import { db, roles } from "@/db";
import { PageShell, Card, PrimaryButton } from "@/components/ui";
import { getLatestBriefing } from "@/lib/briefing";
import { generateBriefingAction } from "@/app/actions";
import { formatDate } from "@/lib/dates";

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

  return (
    <PageShell
      title="Daily briefing"
      subtitle="Rule-based. Auditable. One focus, with the reasoning."
      actions={
        <form action={generateBriefingAction}>
          <PrimaryButton>Generate today’s briefing</PrimaryButton>
        </form>
      }
    >
      {!b && <p className="text-sm text-neutral-500">No briefing yet. Generate one above.</p>}
      {b && (
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-neutral-500">{formatDate(b.briefingDate)}</div>
            {focusName && (
              <div className="text-sm">
                Focus: <span className="font-semibold">{focusName}</span>
              </div>
            )}
          </div>
          {b.summary && <p className="text-base font-medium">{b.summary}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Block title="Why this" body={b.whyThis} />
            <Block title="Why now" body={b.whyNow} />
            <Block title="Why not the others" body={b.whyNotOtherRoles} />
            <Block title="Next 15-minute action" body={b.next15MinuteAction} />
            <Block title="Safe to ignore" body={b.safeToIgnore} />
            <Block title="Avoidance alerts" body={b.avoidanceAlerts} />
          </div>
        </Card>
      )}
    </PageShell>
  );
}
