import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db, roles, projects, tasks, roleAttentionEvents } from "@/db";
import { PageShell, Card, Badge, Field, TextArea, Select, PrimaryButton } from "@/components/ui";
import { logAttentionEvent } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const ATTENTION_OPTS = [
  { value: "progress", label: "Progress (built/shipped something)" },
  { value: "focused_work", label: "Focused work" },
  { value: "planning", label: "Planning" },
  { value: "thinking", label: "Thinking" },
  { value: "relationship", label: "Relationship / connection" },
  { value: "maintenance", label: "Maintenance" },
  { value: "rest", label: "Rest" },
];

export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) notFound();

  const roleProjects = await db.select().from(projects).where(eq(projects.roleId, id));
  const roleTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.roleId, id), eq(tasks.status, "open")));
  const attention = await db
    .select()
    .from(roleAttentionEvents)
    .where(eq(roleAttentionEvents.roleId, id))
    .orderBy(desc(roleAttentionEvents.createdAt))
    .limit(10);

  return (
    <PageShell
      title={role.name}
      subtitle="Role detail"
      actions={
        <Link href="/roles" className="text-sm text-neutral-600 hover:underline">
          ← All roles
        </Link>
      }
    >
      <div className="flex gap-2 mb-4">
        <Badge value={role.currentStatus} />
        <Badge value={role.importanceLevel} />
      </div>

      <Card className="mb-4 space-y-3">
        {([
          ["Mission", role.mission],
          ["Desired state", role.desiredState],
          ["Warning signs", role.warningSigns],
          ["Maintenance minimum", role.maintenanceMinimum],
        ] as const).map(([label, val]) =>
          val ? (
            <div key={label}>
              <div className="text-xs font-medium text-neutral-500">{label}</div>
              <div className="text-sm text-neutral-800">{val}</div>
            </div>
          ) : null
        )}
        <div className="text-xs text-neutral-400">
          Last meaningful attention: {formatDate(role.lastMeaningfulAttentionAt)}
        </div>
      </Card>

      <h2 className="text-sm font-semibold mb-2">Projects ({roleProjects.length})</h2>
      <div className="grid gap-2 mb-6">
        {roleProjects.length === 0 && <p className="text-sm text-neutral-500">No projects.</p>}
        {roleProjects.map((p) => (
          <Card key={p.id}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{p.name}</span>
              <div className="flex gap-1">
                <Badge value={p.status} />
                <Badge value={p.strategicImportance} />
              </div>
            </div>
            {p.lastMeaningfulProgressAt && (
              <p className="text-xs text-neutral-400 mt-1">Last progress: {formatDate(p.lastMeaningfulProgressAt)}</p>
            )}
          </Card>
        ))}
      </div>

      <h2 className="text-sm font-semibold mb-2">Open tasks ({roleTasks.length})</h2>
      <div className="grid gap-2">
        {roleTasks.length === 0 && <p className="text-sm text-neutral-500">No open tasks.</p>}
        {roleTasks.map((t) => (
          <Card key={t.id}>
            <div className="flex items-center justify-between">
              <span className="text-sm">{t.title}</span>
              <div className="flex gap-1 items-center">
                {t.avoidanceCount > 0 && (
                  <span className="text-xs text-amber-700">avoided {t.avoidanceCount}×</span>
                )}
                <Badge value={t.priority} />
              </div>
            </div>
            {t.dueDate && <p className="text-xs text-neutral-400 mt-1">Due {formatDate(t.dueDate)}</p>}
          </Card>
        ))}
      </div>

      <h2 className="text-sm font-semibold mt-6 mb-2">Attention</h2>
      <Card className="mb-3">
        <p className="text-xs text-neutral-500 mb-3">
          Log time/energy given to this role. The Chief of Staff will do this automatically from
          chat in the next phase — this manual form exists for testing and correction.
        </p>
        <form action={logAttentionEvent} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="roleId" value={role.id} />
          <Select label="Type" name="attentionType" options={ATTENTION_OPTS} defaultValue="progress" />
          <Field label="Duration (minutes)" name="durationMinutes" type="number" placeholder="e.g. 60" />
          <Select
            label="Project (optional)"
            name="projectId"
            options={roleProjects.map((p) => ({ value: p.id, label: p.name }))}
            includeBlank="— none —"
          />
          <div className="sm:col-span-2">
            <TextArea label="Notes" name="notes" rows={1} />
          </div>
          <div className="sm:col-span-2">
            <PrimaryButton>Log attention</PrimaryButton>
          </div>
        </form>
      </Card>

      <div className="grid gap-2">
        {attention.length === 0 && (
          <p className="text-sm text-neutral-500">No attention logged yet.</p>
        )}
        {attention.map((a) => (
          <Card key={a.id}>
            <div className="flex items-center justify-between">
              <span className="text-sm">
                <span className="font-medium">{a.attentionType.replace("_", " ")}</span>
                {a.durationMinutes ? ` · ${a.durationMinutes} min` : ""}
                {a.notes ? ` — ${a.notes}` : ""}
              </span>
              <span className="text-xs text-neutral-400">{formatDate(a.createdAt)}</span>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
