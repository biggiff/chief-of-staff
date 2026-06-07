import { db, integrations } from "@/db";
import { PageShell, Card, Badge, PrimaryButton } from "@/components/ui";
import { todoistEnabled } from "@/lib/integrations/todoist";
import { calendarEnabled, googleConfigured } from "@/lib/integrations/google-calendar";
import { gmailConfigured } from "@/lib/integrations/gmail";
import { syncTodoistAction } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const PLANNED = [
  { provider: "Todoist", note: "Pull your real tasks in so the briefing weighs actual to-dos." },
  { provider: "Google Calendar", note: "Pull events to weigh time pressure into briefings." },
  { provider: "Gmail", note: "Read mail (all folders), draft, and send (with your okay)." },
  { provider: "Apple Reminders", note: "Capture quick tasks from anywhere." },
  { provider: "Resend", note: "Email the daily briefing." },
  { provider: "AI Provider", note: "Conversational Chief of Staff (Claude)." },
];

export default async function IntegrationsPage() {
  const rows = await db.select().from(integrations);
  const rowFor = (p: string) => rows.find((r) => r.provider === p);
  const aiOn = !!process.env.ANTHROPIC_API_KEY;

  return (
    <PageShell title="Integrations" subtitle="Connect real data sources to power the briefing.">
      <div className="grid gap-3">
        {PLANNED.map((p) => {
          const row = rowFor(p.provider);
          const isTodoist = p.provider === "Todoist";
          const isCalendar = p.provider === "Google Calendar";
          const isGmail = p.provider === "Gmail";
          const isAI = p.provider === "AI Provider";
          const status = isAI
            ? aiOn
              ? "connected"
              : "not_connected"
            : isCalendar
            ? calendarEnabled()
              ? "connected"
              : "not_connected"
            : isGmail
            ? gmailConfigured()
              ? "connected"
              : "not_connected"
            : isTodoist && todoistEnabled()
            ? row?.status ?? "connected"
            : row?.status ?? "not_connected";
          const lastError = (row?.settingsJson as { lastError?: string } | null)?.lastError;

          return (
            <Card key={p.provider}>
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-sm">{p.provider}</div>
                  <div className="text-xs text-neutral-500">{p.note}</div>
                  {row?.lastSyncAt && (
                    <div className="text-xs text-neutral-400 mt-0.5">
                      Last sync: {formatDate(row.lastSyncAt)}
                    </div>
                  )}
                  {status === "error" && lastError && (
                    <div className="text-xs text-red-600 mt-0.5">Error: {lastError}</div>
                  )}
                </div>
                <Badge value={status} />
              </div>

              {isTodoist && (
                <div className="mt-3">
                  {todoistEnabled() ? (
                    <form action={syncTodoistAction}>
                      <PrimaryButton>Sync now</PrimaryButton>
                    </form>
                  ) : (
                    <div className="text-xs text-neutral-600 bg-neutral-50 rounded-lg p-3 space-y-1">
                      <div className="font-medium text-neutral-800">To connect Todoist:</div>
                      <div>
                        1. In Todoist, open <span className="font-mono">Settings → Integrations → Developer</span> and copy your API token.
                      </div>
                      <div>
                        2. Add <span className="font-mono">TODOIST_API_TOKEN=…</span> to <span className="font-mono">.env.local</span> (and to Vercel env vars for production), then restart.
                      </div>
                    </div>
                  )}
                </div>
              )}

              {isCalendar && !calendarEnabled() && (
                <div className="mt-3 text-xs text-neutral-600 bg-neutral-50 rounded-lg p-3 space-y-1">
                  <div className="font-medium text-neutral-800">To connect Google Calendar:</div>
                  <div>
                    1. Create an OAuth client in Google Cloud Console (Desktop app) with the
                    Calendar API enabled.
                  </div>
                  <div>
                    2. Add <span className="font-mono">GOOGLE_CLIENT_ID</span> and{" "}
                    <span className="font-mono">GOOGLE_CLIENT_SECRET</span> to{" "}
                    <span className="font-mono">.env.local</span>.
                  </div>
                  <div>
                    3. Run <span className="font-mono">npm run google:auth</span> and approve access —
                    it saves your refresh token automatically.
                  </div>
                  {googleConfigured() && (
                    <div className="text-amber-700">
                      Client configured — just run <span className="font-mono">npm run google:auth</span> to finish.
                    </div>
                  )}
                </div>
              )}

              {isGmail && (
                <div className="mt-3 text-xs text-neutral-600 bg-neutral-50 rounded-lg p-3 space-y-1">
                  <div className="font-medium text-neutral-800">Gmail uses the same Google sign-in as Calendar.</div>
                  <div>
                    1. Enable the Gmail API in Google Cloud Console.
                  </div>
                  <div>
                    2. Re-run <span className="font-mono">npm run google:auth</span> and approve the new
                    mail permissions (read / draft / send). That refreshed token covers Gmail.
                  </div>
                  <div className="text-neutral-500">
                    Scout reads all folders and can draft freely, but always asks before sending.
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-neutral-400 mt-4">
        Tokens live in environment variables, never in the database or git.
      </p>
    </PageShell>
  );
}
