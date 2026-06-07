import { desc, isNull } from "drizzle-orm";
import { db, roles, projects } from "@/db";
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
  IMPORTANCE_OPTS,
} from "@/components/ui";
import { FilterBar } from "@/components/FilterBar";
import { createProject, updateProject, archiveProject, markProjectProgress } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const STATUS_OPTS = [
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];
const ENERGY_OPTS = IMPORTANCE_OPTS;

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const allRoles = await db.select().from(roles).where(isNull(roles.archivedAt));
  const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
  const roleOpts = allRoles.map((r) => ({ value: r.id, label: r.name }));

  let list = await db.select().from(projects).orderBy(desc(projects.updatedAt));
  if (sp.role) list = list.filter((p) => p.roleId === sp.role);
  if (sp.status) list = list.filter((p) => p.status === sp.status);

  return (
    <PageShell title="Projects" subtitle="Concrete efforts inside a role.">
      <div className="mb-6">
        <Disclosure summary="+ New project">
          <form action={createProject} className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" name="name" required />
            <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" />
            <Select label="Status" name="status" options={STATUS_OPTS} defaultValue="active" />
            <Select label="Strategic importance" name="strategicImportance" options={IMPORTANCE_OPTS} defaultValue="medium" />
            <Select label="Energy required" name="energyRequired" options={ENERGY_OPTS} defaultValue="medium" />
            <Field label="Deadline" name="deadline" type="date" />
            <div className="sm:col-span-2"><TextArea label="Description" name="description" /></div>
            <div className="sm:col-span-2"><TextArea label="Desired outcome" name="desiredOutcome" /></div>
            <div className="sm:col-span-2"><PrimaryButton>Create project</PrimaryButton></div>
          </form>
        </Disclosure>
      </div>

      <FilterBar roleOpts={roleOpts} statusOpts={STATUS_OPTS} basePath="/projects" current={sp} />

      <div className="grid gap-3 mt-4">
        {list.length === 0 && <p className="text-sm text-neutral-500">No projects match.</p>}
        {list.map((p) => (
          <Card key={p.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-neutral-500">
                  {p.roleId ? roleMap.get(p.roleId) ?? "—" : "No role"}
                  {" · last progress "}
                  {formatDate(p.lastMeaningfulProgressAt)}
                  {p.deadline ? ` · due ${formatDate(p.deadline)}` : ""}
                </div>
              </div>
              <div className="flex gap-1">
                <Badge value={p.status} />
                <Badge value={p.strategicImportance} />
              </div>
            </div>
            {p.description && <p className="text-sm text-neutral-600 mt-2">{p.description}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <form action={markProjectProgress}>
                <input type="hidden" name="id" value={p.id} />
                <GhostButton>Log progress</GhostButton>
              </form>
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateProject} className="grid gap-3 sm:grid-cols-2 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={p.id} />
                  <Field label="Name" name="name" defaultValue={p.name} required />
                  <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" defaultValue={p.roleId} />
                  <Select label="Status" name="status" options={STATUS_OPTS} defaultValue={p.status} />
                  <Select label="Strategic importance" name="strategicImportance" options={IMPORTANCE_OPTS} defaultValue={p.strategicImportance} />
                  <Select label="Energy required" name="energyRequired" options={ENERGY_OPTS} defaultValue={p.energyRequired} />
                  <Field label="Deadline" name="deadline" type="date" defaultValue={p.deadline ? p.deadline.toISOString().slice(0, 10) : ""} />
                  <div className="sm:col-span-2"><TextArea label="Description" name="description" defaultValue={p.description} /></div>
                  <div className="sm:col-span-2"><TextArea label="Desired outcome" name="desiredOutcome" defaultValue={p.desiredOutcome} /></div>
                  <div className="sm:col-span-2"><PrimaryButton>Save</PrimaryButton></div>
                </form>
              </details>
              <form action={archiveProject}>
                <input type="hidden" name="id" value={p.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
