import Link from "next/link";
import { asc, isNull } from "drizzle-orm";
import { db, roles } from "@/db";
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
  ROLE_STATUS_OPTS,
} from "@/components/ui";
import { createRole, updateRole, archiveRole, markRoleAttention } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function RolesPage() {
  const all = await db.select().from(roles).where(isNull(roles.archivedAt)).orderBy(asc(roles.name));

  return (
    <PageShell title="Roles" subtitle="The major areas of your life. Everything connects back here.">
      <div className="mb-6">
        <Disclosure summary="+ New role">
          <form action={createRole} className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" name="name" required />
            <Select label="Importance" name="importanceLevel" options={IMPORTANCE_OPTS} defaultValue="medium" />
            <Select label="Current status" name="currentStatus" options={ROLE_STATUS_OPTS} defaultValue="maintaining" />
            <Field label="Short description" name="description" />
            <div className="sm:col-span-2"><TextArea label="Mission" name="mission" /></div>
            <div className="sm:col-span-2"><TextArea label="Desired state" name="desiredState" /></div>
            <div className="sm:col-span-2"><TextArea label="Warning signs" name="warningSigns" /></div>
            <div className="sm:col-span-2"><TextArea label="Maintenance minimum" name="maintenanceMinimum" /></div>
            <div className="sm:col-span-2"><PrimaryButton>Create role</PrimaryButton></div>
          </form>
        </Disclosure>
      </div>

      {all.length === 0 && <p className="text-sm text-neutral-500">No roles yet. Run the seed script or add one above.</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        {all.map((r) => (
          <Card key={r.id}>
            <div className="flex items-start justify-between gap-2">
              <Link href={`/roles/${r.id}`} className="font-medium hover:underline">
                {r.name}
              </Link>
              <div className="flex gap-1">
                <Badge value={r.currentStatus} />
                <Badge value={r.importanceLevel} />
              </div>
            </div>
            {r.mission && <p className="text-sm text-neutral-600 mt-2 line-clamp-3">{r.mission}</p>}
            <p className="text-xs text-neutral-400 mt-2">
              Last meaningful attention: {formatDate(r.lastMeaningfulAttentionAt)}
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <form action={markRoleAttention}>
                <input type="hidden" name="id" value={r.id} />
                <GhostButton>Log attention</GhostButton>
              </form>
              <details className="inline-block">
                <summary className="cursor-pointer text-sm text-neutral-600 hover:underline list-none px-2 py-1.5">Edit</summary>
                <form action={updateRole} className="grid gap-3 mt-3 p-3 rounded-lg bg-neutral-50">
                  <input type="hidden" name="id" value={r.id} />
                  <Field label="Name" name="name" defaultValue={r.name} required />
                  <Select label="Importance" name="importanceLevel" options={IMPORTANCE_OPTS} defaultValue={r.importanceLevel} />
                  <Select label="Current status" name="currentStatus" options={ROLE_STATUS_OPTS} defaultValue={r.currentStatus} />
                  <Field label="Description" name="description" defaultValue={r.description} />
                  <TextArea label="Mission" name="mission" defaultValue={r.mission} />
                  <TextArea label="Desired state" name="desiredState" defaultValue={r.desiredState} />
                  <TextArea label="Warning signs" name="warningSigns" defaultValue={r.warningSigns} />
                  <TextArea label="Maintenance minimum" name="maintenanceMinimum" defaultValue={r.maintenanceMinimum} />
                  <PrimaryButton>Save</PrimaryButton>
                </form>
              </details>
              <form action={archiveRole}>
                <input type="hidden" name="id" value={r.id} />
                <GhostButton>Archive</GhostButton>
              </form>
            </div>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
