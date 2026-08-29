import { funnelByAccount, leadFunnel, type LeadFunnel } from "@/core/funnel";
import { handleError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Feedback-learning analytics and the outbound funnel.
 *
 * Read-only on purpose. This layer surfaces what is working so a human can
 * decide what to change; it never rewrites prompts or the playbook itself.
 * Prompt changes stay in version control where they are auditable.
 *
 * The funnel is segmented by outbound account, because that is the comparison
 * that matters once outreach runs from more than one page: two accounts sending
 * the same volume with very different reply rates is a fact about the accounts,
 * not about the setter.
 */
export async function GET(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    const param = new URL(request.url).searchParams.get("account");
    const accountId = param === null || param === "all" ? undefined : param === "none" ? null : param;

    const [stats, accounts, leads] = await Promise.all([
      store.feedbackStats(),
      store.listOutboundAccounts({ includeInactive: true }),
      store.listLeads({ accountId }),
    ]);

    // Each conversation is placed in the funnel from what is actually recorded,
    // so the numbers can always be recomputed from the underlying data.
    const perLead: LeadFunnel[] = [];
    for (const lead of leads) {
      const [messages, memory] = await Promise.all([store.listMessages(lead.id), store.getMemory(lead.id)]);
      perLead.push(leadFunnel({ lead, messages, memory }));
    }

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
      funnel_by_account: funnelByAccount(perLead, accounts),
      account_filter: param ?? "all",
      funnel_note:
        "Every stage is derived from the recorded messages, booking sequence and outcome. Conversations with no outbound account appear under a null account rather than being folded into one.",
      note: "Analytics are advisory. Prompt and playbook changes remain manual and version-controlled.",
    });
  } catch (error) {
    return handleError(error);
  }
}
