import { handleError, ok } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { TRANSCRIPT_STATUSES } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Lists the historical corpus, for the transcript verification workflow. */
export async function GET(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    if (status && !TRANSCRIPT_STATUSES.includes(status as (typeof TRANSCRIPT_STATUSES)[number])) {
      return Response.json({ error: "Unknown status" }, { status: 400 });
    }

    const store = getStore();
    const all = await store.listSourceConversations();
    const rows = status ? all.filter((r) => r.status === status) : all;

    const counts = all.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});

    return ok({
      conversations: rows.map((r) => ({
        id: r.id,
        instagram_handle: r.instagram_handle,
        setter_name: r.setter_name,
        outcome: r.outcome,
        outcome_tier: r.outcome_tier,
        status: r.status,
        screenshot_count: Array.isArray(r.screenshot_paths) ? r.screenshot_paths.length : 0,
        transcript: r.transcript,
        labels: r.labels,
        verified_by: r.verified_by,
        verified_at: r.verified_at,
      })),
      counts,
      total: all.length,
    });
  } catch (error) {
    return handleError(error);
  }
}
