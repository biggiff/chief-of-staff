import { desc, eq } from "drizzle-orm";
import { db, workingAgreements } from "@/db";
import { PageShell, Card, Badge, Field, Select, PrimaryButton, GhostButton, Disclosure } from "@/components/ui";
import { createAgreement, updateAgreement, archiveAgreement } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const CATEGORY_OPTS = [
  { value: "behavior", label: "Behavior" },
  { value: "priority", label: "Priority" },
  { value: "style", label: "Style" },
  { value: "correction", label: "Correction" },
  { value: "lesson", label: "Lesson" },
];

export default async function AgreementsPage() {
  const active = await db
    .select()
    .from(workingAgreements)
    .where(eq(workingAgreements.status, "active"))
    .orderBy(desc(workingAgreements.createdAt));

  return (
    <PageShell
      title="Working Agreements"
      subtitle="How you want Scout to operate. These load into Scout every session and shape his behavior."
    >
      <div className="mb-6">
        <Disclosure summary="+ New agreement">
          <form action={createAgreement} className="grid gap-3">
            <Field label="Agreement (phrase it as a durable rule)" name="text" required />
            <Select label="Category" name="category" options={CATEGORY_OPTS} defaultValue="behavior" />
            <PrimaryButton>Add agreement</PrimaryButton>
          </form>
        </Disclosure>
      </div>

      <div className="grid gap-2">
        {active.length === 0 && (
          <p className="text-sm text-neutral-500">
            No agreements yet. Tell Scout how you want him to work — e.g. “always explain your
            prioritization” — and he’ll save it here automatically.
          </p>
        )}
        {active.map((a) => (
          <Card key={a.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="text-sm text-neutral-900">{a.text}</div>
              <Badge value={a.category} />
            </div>
            <div className="text-xs text-neutral-400 mt-1">
              {a.source === "learned" ? "learned from chat" : "added manually"} · {formatDate(a.createdAt)}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateAgreement} className="grid gap-3 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={a.id} />
                  <Field label="Agreement" name="text" defaultValue={a.text} required />
                  <Select label="Category" name="category" options={CATEGORY_OPTS} defaultValue={a.category} />
                  <PrimaryButton>Save</PrimaryButton>
                </form>
              </details>
              <form action={archiveAgreement}>
                <input type="hidden" name="id" value={a.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
