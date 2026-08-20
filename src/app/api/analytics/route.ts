import { handleError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Feedback-learning analytics.
 *
 * Read-only on purpose. This layer surfaces what is working so a human can
 * decide what to change; it never rewrites prompts or the playbook itself.
 * Prompt changes stay in version control where they are auditable.
 */
export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    const stats = await store.feedbackStats();

    const totals = stats.by_feedback.reduce((sum, r) => sum + r.count, 0);
    const used = stats.by_feedback.find((r) => r.feedback === "used")?.count ?? 0;
    const edited = stats.by_feedback.find((r) => r.feedback === "edited")?.count ?? 0;
    const rejected = stats.by_feedback.find((r) => r.feedback === "rejected")?.count ?? 0;

    return ok({
      ...stats,
      summary: {
        total_with_feedback: totals,
        used,
        edited,
        rejected,
        acceptance_rate: totals ? Number(((used + edited) / totals).toFixed(3)) : null,
        clean_acceptance_rate: totals ? Number((used / totals).toFixed(3)) : null,
      },
      note: "Analytics are advisory. Prompt and playbook changes remain manual and version-controlled.",
    });
  } catch (error) {
    return handleError(error);
  }
}
