import { applyHumanCorrection, MEMORY_LIST_FIELDS, type MemoryListField } from "@/core/memory";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = Partial<Record<MemoryListField, string[]>> & {
  relationship_summary?: string | null;
  communication_style?: string | null;
  service_understanding?: number | null;
  service_explained?: boolean | null;
};

export async function GET(_request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    return ok({ memory: await getStore().getMemory(id) });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Applies a human correction to lead memory.
 *
 * Corrected fields are marked verified, which stops later automatic updates
 * from overwriting them with weaker model guesses.
 */
export async function PATCH(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);

    const corrections: Body = {};
    for (const field of MEMORY_LIST_FIELDS) {
      const value = body[field];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        return fail(`${field} must be an array of strings`);
      }
      corrections[field] = value.map((v) => v.trim()).filter(Boolean);
    }
    if (body.relationship_summary !== undefined) corrections.relationship_summary = body.relationship_summary;
    if (body.communication_style !== undefined) corrections.communication_style = body.communication_style;
    if (body.service_explained !== undefined) corrections.service_explained = body.service_explained;
    if (body.service_understanding !== undefined) {
      const level = Number(body.service_understanding);
      if (!Number.isInteger(level) || level < 0 || level > 2) return fail("service_understanding must be 0, 1 or 2");
      corrections.service_understanding = level;
    }

    if (Object.keys(corrections).length === 0) return fail("No correctable fields in the request");

    const store = getStore();
    if (!(await store.getLead(id))) return fail("Lead not found", 404);

    const existing = await store.getMemory(id);
    const patch = applyHumanCorrection(existing, id, corrections);
    return ok({ memory: await store.upsertMemory(id, patch) });
  } catch (error) {
    return handleError(error);
  }
}
