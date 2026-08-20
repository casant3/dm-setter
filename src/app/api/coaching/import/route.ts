import { parseChatGptExport } from "@/core/coaching";
import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Cap per import, so one paste cannot bury the review queue. */
const MAX_CANDIDATES = 100;

/**
 * Imports coaching candidates from a ChatGPT export.
 *
 * Every candidate lands as `pending_review`. The export contains drafts,
 * rejected ideas and thinking-out-loud alongside messages Cassey stood behind,
 * and nothing in the file distinguishes them — so nothing here is trusted.
 */
export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<{ export?: unknown }>(request);
    if (body.export === undefined) return fail("Paste the ChatGPT export JSON as `export`");

    const candidates = parseChatGptExport(body.export);
    if (candidates.length === 0) return fail("No DM-like messages found in that export", 422);

    const store = getStore();
    const setter = process.env.SETTER_VOICE || "Cassey";
    const created = [];
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      created.push(
        await store.createCoachingExample({
          setter_name: setter,
          situation: candidate.situation,
          prospect_message: candidate.prospect_message,
          approved_reply: candidate.approved_reply,
          why: candidate.why,
          source: "chatgpt_import",
          status: "pending_review",
          tags: ["imported"],
          approved_at: null,
        }),
      );
    }

    return ok({
      imported: created.length,
      skipped: Math.max(0, candidates.length - created.length),
      note: "Nothing imported affects a suggestion until it is approved.",
      examples: created,
    });
  } catch (error) {
    return handleError(error);
  }
}
