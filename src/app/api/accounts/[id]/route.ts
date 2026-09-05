import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };
type Body = { display_name?: string | null; active?: boolean; notes?: string | null };

/**
 * Renames a page, retires it, or annotates it.
 *
 * The handle itself is deliberately not editable: leads, messages and analytics
 * are attributed to this row, and renaming it after the fact would silently
 * rewrite the history of which page said what. Retire it and add the new one.
 */
export async function PATCH(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);
    const store = getStore();

    const account = await store.getOutboundAccount(id);
    if (!account) return fail("Outbound account not found", 404);

    const updated = await store.updateOutboundAccount(id, {
      ...(body.display_name !== undefined ? { display_name: body.display_name?.trim() || null } : {}),
      ...(body.active !== undefined ? { active: Boolean(body.active) } : {}),
      ...(body.notes !== undefined ? { notes: body.notes?.trim() || null } : {}),
    });
    return ok({ account: updated });
  } catch (error) {
    return handleError(error);
  }
}
