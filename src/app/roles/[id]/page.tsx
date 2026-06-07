import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, roles, projects, tasks } from "@/db";
import { PageShell, Card, Badge } from "@/components/ui";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function RoleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [role] = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  if (!role) notFound();

  const roleProjects = await db.select().from(projects).where(eq(projects.roleId, id));
  const roleTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.roleId, id), eq(tasks.status, "open")));

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
    </PageShell>
  );
}
