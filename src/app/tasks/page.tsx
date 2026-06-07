import { desc, isNull } from "drizzle-orm";
import { db, roles, projects, tasks } from "@/db";
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
import { createTask, updateTask, completeTask, archiveTask } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const STATUS_OPTS = [
  { value: "open", label: "Open" },
  { value: "completed", label: "Completed" },
  { value: "archived", label: "Archived" },
];

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; status?: string; project?: string }>;
}) {
  const sp = await searchParams;
  const allRoles = await db.select().from(roles).where(isNull(roles.archivedAt));
  const allProjects = await db.select().from(projects);
  const roleMap = new Map(allRoles.map((r) => [r.id, r.name]));
  const projMap = new Map(allProjects.map((p) => [p.id, p.name]));
  const roleOpts = allRoles.map((r) => ({ value: r.id, label: r.name }));
  const projOpts = allProjects.map((p) => ({ value: p.id, label: p.name }));

  let list = await db.select().from(tasks).orderBy(desc(tasks.createdAt));
  if (sp.role) list = list.filter((t) => t.roleId === sp.role);
  if (sp.status) list = list.filter((t) => t.status === sp.status);
  if (sp.project) list = list.filter((t) => t.projectId === sp.project);

  return (
    <PageShell title="Tasks" subtitle="Discrete to-dos. Avoidance is tracked, not hidden.">
      <div className="mb-6">
        <Disclosure summary="+ New task">
          <form action={createTask} className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2"><Field label="Title" name="title" required /></div>
            <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" />
            <Select label="Project" name="projectId" options={projOpts} includeBlank="— none —" />
            <Select label="Priority" name="priority" options={IMPORTANCE_OPTS} defaultValue="medium" />
            <Select label="Status" name="status" options={STATUS_OPTS} defaultValue="open" />
            <Field label="Due date" name="dueDate" type="date" />
            <Field label="Estimated minutes" name="estimatedMinutes" type="number" />
            <div className="sm:col-span-2"><TextArea label="Notes" name="notes" /></div>
            <div className="sm:col-span-2"><PrimaryButton>Create task</PrimaryButton></div>
          </form>
        </Disclosure>
      </div>

      <FilterBar roleOpts={roleOpts} statusOpts={STATUS_OPTS} basePath="/tasks" current={sp} />

      <div className="grid gap-2 mt-4">
        {list.length === 0 && <p className="text-sm text-neutral-500">No tasks match.</p>}
        {list.map((t) => (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-2">
              <div className={t.status === "completed" ? "line-through text-neutral-400" : ""}>
                <div className="text-sm font-medium">{t.title}</div>
                <div className="text-xs text-neutral-500">
                  {t.roleId ? roleMap.get(t.roleId) : "No role"}
                  {t.projectId ? ` › ${projMap.get(t.projectId)}` : ""}
                  {t.dueDate ? ` · due ${formatDate(t.dueDate)}` : ""}
                  {t.estimatedMinutes ? ` · ~${t.estimatedMinutes}m` : ""}
                </div>
              </div>
              <div className="flex gap-1 items-center">
                {t.avoidanceCount > 0 && (
                  <span className="text-xs text-amber-700">avoided {t.avoidanceCount}×</span>
                )}
                <Badge value={t.priority} />
                <Badge value={t.status} />
              </div>
            </div>
            {t.notes && <p className="text-sm text-neutral-600 mt-2">{t.notes}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {t.status !== "completed" && (
                <form action={completeTask}>
                  <input type="hidden" name="id" value={t.id} />
                  <GhostButton>Complete</GhostButton>
                </form>
              )}
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateTask} className="grid gap-3 sm:grid-cols-2 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={t.id} />
                  <div className="sm:col-span-2"><Field label="Title" name="title" defaultValue={t.title} required /></div>
                  <Select label="Role" name="roleId" options={roleOpts} includeBlank="— none —" defaultValue={t.roleId} />
                  <Select label="Project" name="projectId" options={projOpts} includeBlank="— none —" defaultValue={t.projectId} />
                  <Select label="Priority" name="priority" options={IMPORTANCE_OPTS} defaultValue={t.priority} />
                  <Select label="Status" name="status" options={STATUS_OPTS} defaultValue={t.status} />
                  <Field label="Due date" name="dueDate" type="date" defaultValue={t.dueDate ? t.dueDate.toISOString().slice(0, 10) : ""} />
                  <Field label="Estimated minutes" name="estimatedMinutes" type="number" defaultValue={t.estimatedMinutes ?? ""} />
                  <div className="sm:col-span-2"><TextArea label="Notes" name="notes" defaultValue={t.notes} /></div>
                  <div className="sm:col-span-2"><PrimaryButton>Save</PrimaryButton></div>
                </form>
              </details>
              <form action={archiveTask}>
                <input type="hidden" name="id" value={t.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
