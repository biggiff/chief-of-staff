import { desc, isNull } from "drizzle-orm";
import { db, roles, ideas } from "@/db";
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
import { FilterBar } from "@/components/FilterBar";
import { createIdea, updateIdea, archiveIdea } from "@/app/actions";

export const dynamic = "force-dynamic";

const STATUS_OPTS = [
  { value: "captured", label: "Captured" },
  { value: "resurfaced", label: "Resurfaced" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export default async function IdeasPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const allRoles = await db.select().from(roles).where(isNull(roles.archivedAt));
  const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
  const roleOpts = allRoles.map((r) => ({ value: r.id, label: r.name }));

  let list = await db.select().from(ideas).orderBy(desc(ideas.createdAt));
  if (sp.role) list = list.filter((i) => i.roleId === sp.role);
  if (sp.status) list = list.filter((i) => i.status === sp.status);

  return (
    <PageShell title="Ideas" subtitle="Capture now, decide later. Nothing demands action.">
      <div className="mb-6">
        <Disclosure summary="+ New idea">
          <form action={createIdea} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Title" name="title" required /></div>
            <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" />
            <Select label="Status" name="status" options={STATUS_OPTS} defaultValue="captured" />
            <div className="sm:col-span-2"><TextArea label="Notes" name="notes" /></div>
            <div className="sm:col-span-2"><PrimaryButton>Capture idea</PrimaryButton></div>
          </form>
        </Disclosure>
      </div>

      <FilterBar roleOpts={roleOpts} statusOpts={STATUS_OPTS} basePath="/ideas" current={sp} />

      <div className="grid gap-2 mt-4">
        {list.length === 0 && <p className="text-sm text-neutral-500">No ideas match.</p>}
        {list.map((i) => (
          <Card key={i.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium">{i.title}</div>
                <div className="text-xs text-neutral-500">{i.roleId ? roleMap.get(i.roleId) : "No role"}</div>
              </div>
              <Badge value={i.status} />
            </div>
            {i.notes && <p className="text-sm text-neutral-600 mt-2">{i.notes}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateIdea} className="grid gap-3 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={i.id} />
                  <Field label="Title" name="title" defaultValue={i.title} required />
                  <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" defaultValue={i.roleId} />
                  <Select label="Status" name="status" options={STATUS_OPTS} defaultValue={i.status} />
                  <TextArea label="Notes" name="notes" defaultValue={i.notes} />
                  <PrimaryButton>Save</PrimaryButton>
                </form>
              </details>
              <form action={archiveIdea}>
                <input type="hidden" name="id" value={i.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
