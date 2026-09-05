import { describeCandidate, parseChatGptExport, type CoachingCandidate } from "@/core/chatgpt-import";
import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import type { CoachingExampleKind } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Cap per import, so one paste cannot bury the review queue. */
const MAX_CANDIDATES = 200;

/**
 * Imports coaching material from a ChatGPT export.
 *
 * The valuable unit is the correction chain — a draft, what Cassey objected to,
 * the next draft, and eventually something he stood behind. Assistant messages
 * are NOT approved examples: most of them are the ones that were rejected, and
 * only an explicit approval in the export marks a reply as one to follow.
 *
 * Every candidate lands as `pending_review` and changes nothing until a person
 * approves it.
 */
export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<{ export?: unknown }>(request);
    if (body.export === undefined) return fail("Paste the ChatGPT export JSON as `export`");

    const candidates = parseChatGptExport(body.export);
    if (candidates.length === 0) {
      return fail("No drafts, corrections or approvals were found in that export", 422);
    }

    const store = getStore();
    const setter = process.env.SETTER_VOICE || "Cassey";
    const created = [];

    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      created.push(
        await store.createCoachingExample({
          setter_name: setter,
          kind: candidate.kind as CoachingExampleKind,
          situation: candidate.situation,
          prospect_message: candidate.prospect_message,
          rejected_reply: candidate.rejected_reply,
          operator_feedback: candidate.operator_feedback,
          // Only an explicit approval in the export sets this. A draft nobody
          // blessed arrives with the better attempt in `revisions` instead.
          approved_reply: candidate.approved_reply,
          revisions: candidate.better_reply && !candidate.approved_reply
            ? [...candidate.revisions, { reply: candidate.better_reply, feedback: null, tags: [] }]
            : candidate.revisions,
          why: describeCandidate(candidate),
          source: "chatgpt_import",
          status: "pending_review",
          tags: candidate.tags,
          applies_when: null,
          approved_at: null,
        }),
      );
    }

    return ok({
      imported: created.length,
      skipped: Math.max(0, candidates.length - created.length),
      breakdown: countKinds(candidates),
      needs_judgement: candidates.filter((c) => c.ambiguous_feedback.length > 0).length,
      note: "Nothing imported affects a suggestion until it is approved. Drafts with no explicit approval carry no approved reply.",
      examples: created,
    });
  } catch (error) {
    return handleError(error);
  }
}

function countKinds(candidates: CoachingCandidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) counts[candidate.kind] = (counts[candidate.kind] ?? 0) + 1;
  return counts;
}
