import { normaliseHandle } from "@/core/accounts";
import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import type { NewOutboundAccount } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The Instagram pages outreach runs from.
 *
 * Attribution only. No credentials are stored here, nothing logs in, and nothing
 * is ever sent by this system — the operator sends, and records which page they
 * sent from so conversations, memory and analytics stay separated.
 */
export async function GET(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    const includeInactive = new URL(request.url).searchParams.get("all") === "1";
    // Ensures the explicit unknown account exists before anything is attributed.
    await store.legacyOutboundAccount();
    const accounts = await store.listOutboundAccounts({ includeInactive });
    return ok({ accounts, note: "Attribution only — this system never sends or logs in to Instagram." });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<NewOutboundAccount>(request);
    const handle = normaliseHandle(String(body.handle ?? ""));
    if (!handle) return fail("An account handle is required");
    if (!/^[a-z0-9._]{1,30}$/.test(handle)) return fail("That does not look like a valid Instagram handle");

    const store = getStore();
    const existing = (await store.listOutboundAccounts({ includeInactive: true })).find(
      (a) => normaliseHandle(a.handle) === handle,
    );
    if (existing) return fail(`@${handle} is already an outbound account`, 409);

    const account = await store.createOutboundAccount({
      platform: body.platform?.trim() || "instagram",
      handle,
      display_name: body.display_name?.trim() || null,
      active: body.active ?? true,
      notes: body.notes?.trim() || null,
    });
    return ok({ account }, 201);
  } catch (error) {
    return handleError(error);
  }
}
