import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type Body = { kind: "rule" | "example"; decision: "approve" | "reject"; rule?: string; approved_reply?: string; why?: string | null };

/**
 * Approves or rejects a proposal.
 *
 * This is the only route by which anything learned from an edit or an import
 * becomes active. Until it is called, a proposal has no effect on any message.
 */
export async function PATCH(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);
    if (body.decision !== "approve" && body.decision !== "reject") return fail("decision must be approve or reject");

    const store = getStore();
    const now = new Date().toISOString();

    if (body.kind === "rule") {
      const preference = await store.updateSetterPreference(id, {
        // A person may correct the wording as they approve it.
        ...(body.rule?.trim() ? { rule: body.rule.trim() } : {}),
        status: body.decision === "approve" ? "active" : "rejected",
        approved_at: body.decision === "approve" ? now : null,
      });
      return ok({ preference });
    }

    if (body.kind === "example") {
      const example = await store.updateCoachingExample(id, {
        ...(body.approved_reply?.trim() ? { approved_reply: body.approved_reply.trim() } : {}),
        ...(body.why !== undefined ? { why: body.why?.trim() || null } : {}),
        status: body.decision === "approve" ? "approved" : "rejected",
        approved_at: body.decision === "approve" ? now : null,
      });
      return ok({ example });
    }

    return fail("kind must be 'rule' or 'example'");
  } catch (error) {
    return handleError(error);
  }
}
