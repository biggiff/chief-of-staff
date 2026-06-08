import { desc, eq } from "drizzle-orm";
import { db, memories, roles, workingAgreements } from "@/db";
import { PageShell, Card, Badge, GhostButton } from "@/components/ui";
import { archiveMemory } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";

const TIER_TITLE: Record<string, string> = {
  identity: "Identity",
  learned_pattern: "Learned patterns",
  temporary_context: "Right now (temporary)",
};

const TIER_BLURB: Record<string, string> = {
  identity: "Durable truths about Selena — values, goals, preferences, life structure. Persist until she changes them.",
  learned_pattern: "Tendencies Scout has observed, with confidence + evidence. Revisable.",
  temporary_context: "Matters now, expires later. Auto-clears past its date.",
};

export default async function MemoryPage() {
  const [rows, allRoles, rules] = await Promise.all([
    db.select().from(memories).where(eq(memories.status, "active")).orderBy(desc(memories.createdAt)),
    db.select().from(roles),
    db.select().from(workingAgreements).where(eq(workingAgreements.status, "active")).orderBy(desc(workingAgreements.createdAt)),
  ]);
  const roleName = new Map(allRoles.map((r) => [r.id, r.name]));
  const byTier = (t: string) => rows.filter((m) => m.type === t);

  return (
    <PageShell
      title="Memory"
      subtitle="What Scout keeps long-term — promoted from conversation, not every conversation. The goal is better memory, not more."
    >
      {/* Operating rules tier (lives in working agreements). */}
      <Card className="mb-3">
        <div className="text-sm font-semibold">Operating rules</div>
        <div className="text-xs text-neutral-500 mb-2">
          How Scout must operate — always loaded and binding.{" "}
          <a href="/agreements" className="underline">Manage on Working Agreements →</a>
        </div>
        <div className="grid gap-1">
          {rules.length === 0 && <p className="text-sm text-neutral-500">No operating rules yet.</p>}
          {rules.map((r) => (
            <div key={r.id} className="text-sm text-neutral-800">• {r.text}</div>
          ))}
        </div>
      </Card>

      {(["identity", "learned_pattern", "temporary_context"] as const).map((tier) => {
        const items = byTier(tier);
        return (
          <div key={tier} className="mb-3">
            <div className="text-sm font-semibold mt-2">{TIER_TITLE[tier]}</div>
            <div className="text-xs text-neutral-500 mb-2">{TIER_BLURB[tier]}</div>
            <div className="grid gap-2">
              {items.length === 0 && (
                <p className="text-sm text-neutral-500">Nothing here yet.</p>
              )}
              {items.map((m) => (
                <Card key={m.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">{m.content}</div>
                      {m.whyItMatters && <p className="text-sm text-neutral-600 mt-1">{m.whyItMatters}</p>}
                      {m.evidence && <p className="text-xs text-neutral-500 mt-1">Evidence: {m.evidence}</p>}
                      <div className="text-xs text-neutral-400 mt-1">
                        {m.roleId && <span>{roleName.get(m.roleId)} · </span>}
                        {m.expiresAt ? `until ${formatDate(m.expiresAt)}` : `since ${formatDate(m.createdAt)}`}
                      </div>
                    </div>
                    {tier === "learned_pattern" && m.confidence && <Badge value={m.confidence} />}
                  </div>
                  <div className="mt-3">
                    <form action={archiveMemory}>
                      <input type="hidden" name="id" value={m.id} />
                      <GhostButton>Forget</GhostButton>
                    </form>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );
      })}
    </PageShell>
  );
}
