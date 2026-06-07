import { desc, eq } from "drizzle-orm";
import { db, proposedUpdates, activityLog } from "@/db";
import { PageShell, Card, Badge, PrimaryButton, GhostButton } from "@/components/ui";
import { acceptProposal, rejectProposal, undoActivityAction } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const pending = await db
    .select()
    .from(proposedUpdates)
    .where(eq(proposedUpdates.status, "pending"))
    .orderBy(desc(proposedUpdates.createdAt));
  const recent = await db
    .select()
    .from(activityLog)
    .orderBy(desc(activityLog.createdAt))
    .limit(15);

  return (
    <PageShell
      title="Review"
      subtitle="Scout's proposed updates awaiting your call, plus recent changes you can undo."
    >
      <h2 className="text-sm font-semibold mb-2">Proposed updates ({pending.length})</h2>
      <div className="grid gap-2 mb-8">
        {pending.length === 0 && (
          <p className="text-sm text-neutral-500">Nothing waiting. Scout queues low-confidence inferences here.</p>
        )}
        {pending.map((p) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{p.summary}</div>
                <div className="text-xs text-neutral-500">{p.kind}</div>
              </div>
              <Badge value={p.confidence} />
            </div>
            <div className="mt-3 flex gap-2">
              <form action={acceptProposal}>
                <input type="hidden" name="id" value={p.id} />
                <PrimaryButton>Accept</PrimaryButton>
              </form>
              <form action={rejectProposal}>
                <input type="hidden" name="id" value={p.id} />
                <GhostButton>Reject</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>

      <h2 className="text-sm font-semibold mb-2">Recent changes</h2>
      <div className="grid gap-2">
        {recent.length === 0 && <p className="text-sm text-neutral-500">No changes logged yet.</p>}
        {recent.map((a) => (
          <Card key={a.id}>
            <div className="flex items-center justify-between gap-2">
              <div className={a.undoneAt ? "line-through text-neutral-400" : ""}>
                <span className="text-sm">{a.summary}</span>
                <span className="text-xs text-neutral-400"> · {formatDate(a.createdAt)} · {a.source}</span>
              </div>
              {!a.undoneAt && a.undoPayloadJson ? (
                <form action={undoActivityAction}>
                  <input type="hidden" name="id" value={a.id} />
                  <GhostButton>Undo</GhostButton>
                </form>
              ) : (
                a.undoneAt && <span className="text-xs text-neutral-400">undone</span>
              )}
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
