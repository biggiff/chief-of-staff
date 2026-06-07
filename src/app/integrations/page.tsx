import { db, integrations } from "@/db";
import { PageShell, Card, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

const PLANNED = [
  { provider: "Google Calendar", note: "Pull events to weigh time pressure into briefings." },
  { provider: "Todoist", note: "Sync tasks both directions." },
  { provider: "Apple Reminders", note: "Capture quick tasks from anywhere." },
  { provider: "Resend", note: "Email the daily briefing." },
  { provider: "AI Provider", note: "Swap rule-based chat for a real model." },
];

export default async function IntegrationsPage() {
  const rows = await db.select().from(integrations);
  const statusFor = (p: string) => rows.find((r) => r.provider === p)?.status ?? "not_connected";

  return (
    <PageShell title="Integrations" subtitle="Planned connections. None are wired up yet.">
      <div className="grid gap-2">
        {PLANNED.map((p) => (
          <Card key={p.provider}>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">{p.provider}</div>
                <div className="text-xs text-neutral-500">{p.note}</div>
              </div>
              <Badge value={statusFor(p.provider)} />
            </div>
          </Card>
        ))}
      </div>
      <p className="text-xs text-neutral-400 mt-4">
        These are intentionally inert in v1. The data model and UI are ready for them.
      </p>
    </PageShell>
  );
}
