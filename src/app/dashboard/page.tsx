import Link from "next/link";
import { asc, desc, eq, isNull } from "drizzle-orm";
import { db, roles, projects, tasks, checkins } from "@/db";
import { PageShell, Card, Badge, PrimaryButton } from "@/components/ui";
import { getLatestBriefing } from "@/lib/briefing";
import { generateBriefingAction } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const activeRoles = await db.select().from(roles).where(isNull(roles.archivedAt)).orderBy(asc(roles.name));
  const openTasks = await db.select().from(tasks).where(eq(tasks.status, "open"));
  const activeProjects = await db.select().from(projects).where(eq(projects.status, "active"));
  const [latestCheckin] = await db.select().from(checkins).orderBy(desc(checkins.checkinDate)).limit(1);
  const briefing = await getLatestBriefing();

  return (
    <PageShell
      title="Dashboard"
      subtitle="A support layer. The day really happens in Chat."
      actions={
        <>
          <Link href="/chat" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">
            Go to Chat
          </Link>
          <form action={generateBriefingAction}>
            <PrimaryButton>Generate briefing</PrimaryButton>
          </form>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3 mb-6">
        <Stat label="Open tasks" value={openTasks.length} />
        <Stat label="Active projects" value={activeProjects.length} />
        <Stat label="Latest check-in" value={latestCheckin ? formatDate(latestCheckin.checkinDate) : "—"} />
      </div>

      {briefing && (
        <Card className="mb-6">
          <div className="flex items-center justify-between mb-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Latest briefing</div>
            <Link href="/briefing" className="text-xs text-neutral-600 hover:underline">View →</Link>
          </div>
          <p className="text-sm">{briefing.summary}</p>
          {briefing.next15MinuteAction && (
            <p className="text-sm text-neutral-600 mt-2">
              <span className="font-medium text-neutral-800">Next 15 min:</span> {briefing.next15MinuteAction}
            </p>
          )}
        </Card>
      )}

      <h2 className="text-sm font-semibold mb-2">Role status</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {activeRoles.map((r) => {
          const roleOpen = openTasks.filter((t) => t.roleId === r.id).length;
          const roleProj = activeProjects.filter((p) => p.roleId === r.id).length;
          return (
            <Link key={r.id} href={`/roles/${r.id}`}>
              <Card className="hover:border-neutral-400 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium">{r.name}</span>
                  <div className="flex gap-1">
                    <Badge value={r.currentStatus} />
                    <Badge value={r.importanceLevel} />
                  </div>
                </div>
                <div className="text-xs text-neutral-500 mt-2">
                  {roleOpen} open task{roleOpen !== 1 ? "s" : ""} · {roleProj} active project{roleProj !== 1 ? "s" : ""}
                </div>
                <div className="text-xs text-neutral-400 mt-1">
                  Last attention: {formatDate(r.lastMeaningfulAttentionAt)}
                </div>
              </Card>
            </Link>
          );
        })}
        {activeRoles.length === 0 && <p className="text-sm text-neutral-500">No roles yet.</p>}
      </div>
    </PageShell>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-neutral-500 mt-1">{label}</div>
    </Card>
  );
}
