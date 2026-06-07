import { desc, eq } from "drizzle-orm";
import { db, decisions, crossroadDiscussions } from "@/db";
import {
  PageShell,
  Card,
  Badge,
  Field,
  TextArea,
  Select,
  PrimaryButton,
  GhostButton,
  Disclosure,
} from "@/components/ui";
import { createDecision, updateDecision, archiveDecision } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const STATUS_OPTS = [
  { value: "active", label: "Active" },
  { value: "decided", label: "Decided" },
  { value: "reopened", label: "Reopened" },
  { value: "archived", label: "Archived" },
];

export default async function CrossroadsPage() {
  const list = await db.select().from(decisions).orderBy(desc(decisions.updatedAt));
  const allDiscussions = await db
    .select()
    .from(crossroadDiscussions)
    .orderBy(crossroadDiscussions.createdAt);
  const timelineByDecision = new Map<string, typeof allDiscussions>();
  for (const d of allDiscussions) {
    if (!timelineByDecision.has(d.decisionId)) timelineByDecision.set(d.decisionId, []);
    timelineByDecision.get(d.decisionId)!.push(d);
  }

  return (
    <PageShell
      title="Crossroads"
      subtitle="Recurring decisions Scout tracks so you don't re-litigate them. Audit/correction view."
    >
      <div className="mb-6">
        <Disclosure summary="+ New crossroad">
          <form action={createDecision} className="grid gap-3">
            <Field label="Title" name="title" required />
            <Select label="Status" name="status" options={STATUS_OPTS} defaultValue="open" />
            <TextArea label="Description" name="description" />
            <Field label="Current leaning / decision" name="decision" />
            <TextArea label="Reasoning" name="reasoning" />
            <Field label="Revisit date" name="revisitDate" type="date" />
            <PrimaryButton>Create crossroad</PrimaryButton>
          </form>
        </Disclosure>
      </div>

      <div className="grid gap-2">
        {list.length === 0 && <p className="text-sm text-neutral-500">No crossroads yet.</p>}
        {list.map((d) => (
          <Card key={d.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-sm">{d.title}</div>
                <div className="text-xs text-neutral-500">
                  {d.revisitCount > 0 ? `Revisited ${d.revisitCount}× · ` : ""}
                  {d.latestDiscussedAt ? `last discussed ${formatDate(d.latestDiscussedAt)}` : ""}
                  {d.revisitDate ? ` · revisit ${formatDate(d.revisitDate)}` : ""}
                </div>
              </div>
              <Badge value={d.status} />
            </div>
            {d.description && <p className="text-sm text-neutral-600 mt-2">{d.description}</p>}
            {(d.currentLeaning || d.decision) && (
              <p className="text-sm mt-2">
                <span className="font-medium">Leaning:</span> {d.currentLeaning || d.decision}
              </p>
            )}
            {d.unresolvedConcerns && (
              <p className="text-sm text-neutral-600 mt-1">
                <span className="font-medium text-neutral-800">Unresolved:</span> {d.unresolvedConcerns}
              </p>
            )}
            {d.reasoning && (
              <p className="text-sm text-neutral-600 mt-1">
                <span className="font-medium text-neutral-800">Reasoning:</span> {d.reasoning}
              </p>
            )}

            {(timelineByDecision.get(d.id)?.length ?? 0) > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-neutral-500 list-none">
                  Discussion timeline ({timelineByDecision.get(d.id)!.length})
                </summary>
                <ol className="mt-2 border-l-2 border-neutral-200 pl-3 space-y-2">
                  {timelineByDecision.get(d.id)!.map((t) => (
                    <li key={t.id} className="text-xs text-neutral-600">
                      <div className="text-neutral-400">{formatDate(t.createdAt)}</div>
                      {t.leaning && <div><span className="font-medium text-neutral-700">Leaning:</span> {t.leaning}</div>}
                      {t.note && <div className="text-neutral-500">{t.note}</div>}
                    </li>
                  ))}
                </ol>
              </details>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateDecision} className="grid gap-3 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={d.id} />
                  <Field label="Title" name="title" defaultValue={d.title} required />
                  <Select label="Status" name="status" options={STATUS_OPTS} defaultValue={d.status} />
                  <TextArea label="Description" name="description" defaultValue={d.description} />
                  <Field label="Current leaning / decision" name="decision" defaultValue={d.decision} />
                  <TextArea label="Reasoning" name="reasoning" defaultValue={d.reasoning} />
                  <Field label="Revisit date" name="revisitDate" type="date" defaultValue={d.revisitDate ? d.revisitDate.toISOString().slice(0, 10) : ""} />
                  <PrimaryButton>Save</PrimaryButton>
                </form>
              </details>
              <form action={archiveDecision}>
                <input type="hidden" name="id" value={d.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
