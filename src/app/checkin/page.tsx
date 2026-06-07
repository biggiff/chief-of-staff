import { asc, desc, isNull } from "drizzle-orm";
import { db, roles, checkins } from "@/db";
import { PageShell, Card, Field, TextArea, PrimaryButton } from "@/components/ui";
import { createCheckin } from "@/app/actions";
import { formatDate, todayStr } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function CheckinPage() {
  const activeRoles = await db.select().from(roles).where(isNull(roles.archivedAt)).orderBy(asc(roles.name));
  const recent = await db.select().from(checkins).orderBy(desc(checkins.checkinDate)).limit(5);

  return (
    <PageShell title="Daily check-in" subtitle="A fast pulse on energy, overwhelm, and each role.">
      <Card className="mb-6">
        <form action={createCheckin} className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date" name="checkinDate" type="date" defaultValue={todayStr()} />
            <Field label="Energy (1-10)" name="energyLevel" type="number" placeholder="1-10" />
            <Field label="Overwhelm (1-10)" name="overwhelmLevel" type="number" placeholder="1-10" />
          </div>
          <TextArea label="Overall notes" name="notes" />

          <div>
            <h2 className="text-sm font-semibold mb-2">Per-role pulse</h2>
            <div className="space-y-3">
              {activeRoles.map((r) => (
                <div key={r.id} className="rounded-lg border border-neutral-200 p-3">
                  <div className="font-medium text-sm mb-2">{r.name}</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Health score (1-10)" name={`health_${r.id}`} type="number" placeholder="1-10" />
                    <Field label="Avoided item" name={`avoided_${r.id}`} />
                    <Field label="Biggest win" name={`win_${r.id}`} />
                    <Field label="Biggest concern" name={`concern_${r.id}`} />
                    <div className="sm:col-span-2"><TextArea label="Notes" name={`notes_${r.id}`} rows={1} /></div>
                  </div>
                </div>
              ))}
              {activeRoles.length === 0 && <p className="text-sm text-neutral-500">No active roles to score.</p>}
            </div>
          </div>

          <PrimaryButton>Save check-in</PrimaryButton>
        </form>
      </Card>

      <h2 className="text-sm font-semibold mb-2">Recent check-ins</h2>
      <div className="grid gap-2">
        {recent.length === 0 && <p className="text-sm text-neutral-500">No check-ins yet.</p>}
        {recent.map((c) => (
          <Card key={c.id}>
            <div className="text-sm">
              <span className="font-medium">{formatDate(c.checkinDate)}</span>
              <span className="text-neutral-500">
                {" "}· energy {c.energyLevel ?? "—"}/10 · overwhelm {c.overwhelmLevel ?? "—"}/10
              </span>
            </div>
            {c.notes && <p className="text-sm text-neutral-600 mt-1">{c.notes}</p>}
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
