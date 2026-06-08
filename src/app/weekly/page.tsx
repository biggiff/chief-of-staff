import { PageShell, Card, GhostButton } from "@/components/ui";
import { getOrGenerateWeeklyReview, markWeeklyReviewOpened } from "@/lib/weekly-review";
import { regenerateWeekly } from "@/app/actions";
import { formatDate } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function WeeklyPage() {
  const review = await getOrGenerateWeeklyReview();
  // Mark seen so the chat nudge stops surfacing it.
  if (!review.openedAt) await markWeeklyReviewOpened(review.id);

  return (
    <PageShell
      title="Weekly review"
      subtitle={`Your chief of staff's read on the week of ${formatDate(review.weekOf)} — what changed, what matters, what's next.`}
      actions={
        <form action={regenerateWeekly}>
          <GhostButton>Regenerate</GhostButton>
        </form>
      }
    >
      <Card className="space-y-4">
        {review.throughline && (
          <p className="text-lg font-medium leading-snug text-neutral-900">{review.throughline}</p>
        )}
        <div className="prose-chat whitespace-pre-wrap text-[15px] leading-relaxed text-neutral-800">
          {review.narrative}
        </div>
        {review.biggestQuestion && (
          <div className="mt-2 rounded-xl bg-neutral-50 px-4 py-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
              The question to sit with
            </div>
            <div className="mt-1 text-[15px] text-neutral-800">{review.biggestQuestion}</div>
          </div>
        )}
      </Card>
    </PageShell>
  );
}
