import { PageShell, Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <PageShell title="Settings" subtitle="Configuration lives here as the app grows.">
      <Card className="space-y-3">
        <div>
          <div className="text-sm font-medium">Authentication</div>
          <div className="text-sm text-neutral-500">Not enabled in v1. Single-user, local.</div>
        </div>
        <div>
          <div className="text-sm font-medium">AI responses</div>
          <div className="text-sm text-neutral-500">
            Chat is rule-based for now. An AI provider can be added under Integrations.
          </div>
        </div>
        <div>
          <div className="text-sm font-medium">Data</div>
          <div className="text-sm text-neutral-500">
            Stored in Neon Postgres. Manage schema with <code className="text-xs">npm run db:push</code> and seed with{" "}
            <code className="text-xs">npm run db:seed</code>.
          </div>
        </div>
      </Card>
    </PageShell>
  );
}
