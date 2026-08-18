import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { TRANSCRIPT_STATUSES, type TranscriptStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const row = await getStore().getSourceConversation(id);
    if (!row) return fail("Conversation not found", 404);
    return ok({ conversation: row });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * The human verification step.
 *
 * A machine transcript is never ground truth: it stays `needs_review` until a
 * person approves it here, and only `verified` conversations are eligible for
 * retrieval. The corrected transcript is stored as the human wrote it.
 */
export async function PATCH(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<{ status?: TranscriptStatus; transcript?: string; verified_by?: string }>(request);

    const store = getStore();
    const existing = await store.getSourceConversation(id);
    if (!existing) return fail("Conversation not found", 404);

    if (body.status && !TRANSCRIPT_STATUSES.includes(body.status)) return fail("Unknown status");

    const transcript = body.transcript?.trim();
    if (body.status === "verified" && !transcript && !existing.transcript) {
      return fail("Cannot verify a conversation that has no transcript");
    }

    const patch: Record<string, unknown> = {};
    if (transcript !== undefined) patch.transcript = transcript;
    if (body.status) {
      patch.status = body.status;
      if (body.status === "verified") {
        patch.verified_by = body.verified_by ?? "operator";
        patch.verified_at = new Date().toISOString();
      }
    }

    // The human-edit path deliberately bypasses the re-ingestion guard: a person
    // must always be able to correct a transcript they previously verified.
    const updated = await store.updateSourceConversation(id, patch as never);

    return ok({ conversation: updated });
  } catch (error) {
    return handleError(error);
  }
}
