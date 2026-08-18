import { defaultDeps, runSetterForLead } from "@/core/agent";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * Runs the strategy → gate → writer → reviewer pipeline for one lead.
 *
 * `prospect_message` is optional: when omitted the pipeline reasons over the
 * stored conversation as it stands, which is what "what should I say next?"
 * means for a thread where the last word was already theirs.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await readJson<{ prospect_message?: string }>(request).catch(() => ({}) as { prospect_message?: string });

    const store = getStore();
    if (!(await store.getLead(id))) return fail("Lead not found", 404);

    const deps = { ...defaultDeps(), store };
    const result = await runSetterForLead(id, (body.prospect_message ?? "").trim(), deps);
    return ok(result);
  } catch (error) {
    return handleError(error);
  }
}
