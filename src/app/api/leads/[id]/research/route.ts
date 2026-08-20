import { makeItem, mergeItems } from "@/core/memory";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type Body = {
  facts?: { value?: string; source?: string | null; url?: string | null; confidence?: number; verified?: boolean }[];
};

const MAX_FACTS = 25;

/**
 * Records what we found out about a lead ourselves.
 *
 * Kept apart from everything they have told us, and provenance-tagged as
 * research, because the two must never be confused in a message: knowing
 * something publicly visible is fine, implying they told you is not.
 */
export async function POST(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);
    const incoming = (body.facts ?? [])
      .map((f) => ({
        value: String(f?.value ?? "").trim(),
        source: f?.source?.trim() || null,
        url: f?.url?.trim() || null,
        confidence: Number.isFinite(f?.confidence) ? Math.max(0, Math.min(1, Number(f?.confidence))) : 0.7,
        // Verified means a person checked the source. Only verified facts may
        // be used in an opener, so this is never defaulted to true.
        verified: f?.verified === true,
      }))
      .filter((f) => f.value);

    if (incoming.length === 0) return fail("At least one fact is required");
    if (incoming.length > MAX_FACTS) return fail(`At most ${MAX_FACTS} facts at a time`);

    const store = getStore();
    if (!(await store.getLead(id))) return fail("Lead not found", 404);

    const memory = await store.getMemory(id);
    if ((memory?.verified_fields ?? []).includes("research_facts")) {
      return fail("Research facts have been corrected by hand and are locked. Edit them in the memory panel.", 409);
    }

    const items = incoming.map((f) =>
      makeItem(f.value, "research", {
        quote: f.source,
        source_ref: f.url ?? f.source,
        confidence: f.confidence,
        verified: f.verified,
      }),
    );
    const updated = await store.upsertMemory(id, {
      lead_id: id,
      research_facts: mergeItems(memory?.research_facts ?? [], items),
      updated_at: new Date().toISOString(),
    });

    return ok({ memory: updated, added: items.length });
  } catch (error) {
    return handleError(error);
  }
}
