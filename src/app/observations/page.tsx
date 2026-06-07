import { desc, eq } from "drizzle-orm";
import { db, insights, roles } from "@/db";
import { PageShell, Card, Badge, GhostButton } from "@/components/ui";
import { dismissObservation, resolveObservation } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function ObservationsPage() {
  const open = await db
    .select()
    .from(insights)
    .where(eq(insights.status, "open"))
    .orderBy(desc(insights.createdAt));
  const allRoles = await db.select().from(roles);
  const roleName = new Map(allRoles.map((r) => [r.id, r.name]));

  return (
    <PageShell
      title="Observations"
      subtitle="Patterns Scout has noticed in Compass. Phase 3 will generate these automatically."
    >
      <div className="grid gap-2">
        {open.length === 0 && (
          <p className="text-sm text-neutral-500">
            No open observations yet. Scout will surface patterns here (e.g. “discussed a lot but
            little progress”) starting in Phase 3.
          </p>
        )}
        {open.map((o) => (
          <Card key={o.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{o.summary}</div>
                {o.roleId && <div className="text-xs text-neutral-500">{roleName.get(o.roleId)}</div>}
                {o.detail && <p className="text-sm text-neutral-600 mt-1">{o.detail}</p>}
                <div className="text-xs text-neutral-400 mt-1">
                  {o.source === "engine" ? "Scout noticed automatically" : o.source === "chat" ? "from chat" : "added manually"} · {formatDate(o.createdAt)}
                </div>
              </div>
              <Badge value={o.severity} />
            </div>
            <div className="mt-3 flex gap-2">
              <form action={resolveObservation}>
                <input type="hidden" name="id" value={o.id} />
                <GhostButton>Mark resolved</GhostButton>
              </form>
              <form action={dismissObservation}>
                <input type="hidden" name="id" value={o.id} />
                <GhostButton>Dismiss</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
