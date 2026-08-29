import { checkDuplicateOutreach } from "@/core/accounts";
import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { PRIORITIES, type NewLeadInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    // `?account=<id>` narrows the inbox to one outbound page; `?account=none`
    // shows the conversations nothing has been attributed to yet.
    const param = new URL(request.url).searchParams.get("account");
    const accountId = param === null || param === "all" ? undefined : param === "none" ? null : param;

    const [leads, accounts] = await Promise.all([
      store.listLeads({ accountId }),
      store.listOutboundAccounts({ includeInactive: true }),
    ]);
    return ok({ leads, accounts, account_filter: param ?? "all", store_mode: store.mode });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const body = await readJson<NewLeadInput>(request);
    const handle = String(body.instagram_handle ?? "")
      .trim()
      .replace(/^@/, "");
    if (!handle) return fail("An Instagram handle is required");
    if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return fail("That does not look like a valid Instagram handle");
    if (body.priority && !PRIORITIES.includes(body.priority)) return fail("Unknown priority");

    const store = getStore();
    const accountId = body.outbound_account_id?.trim() || null;
    if (accountId && !(await store.getOutboundAccount(accountId))) return fail("Unknown outbound account", 400);

    // The same prospect may legitimately be reached from a second page — a
    // personal page and a brand page both have reasons to — so this is a warning
    // the operator must see rather than a rule the code enforces. What it will
    // not do is let the same page open a second thread with the same person.
    const duplicate = checkDuplicateOutreach({
      handle,
      accountId,
      existing: await store.findLeadsByHandle(handle),
      accounts: await store.listOutboundAccounts({ includeInactive: true }),
    });
    const acknowledged = Boolean((body as { acknowledge_duplicate?: boolean }).acknowledge_duplicate);
    if (duplicate.severity === "blocked") return fail(duplicate.message, 409);
    if (duplicate.severity === "warn" && !acknowledged) {
      return ok({ duplicate, requires_acknowledgement: true }, 409);
    }

    const lead = await store.createLead({
      instagram_handle: handle,
      outbound_account_id: accountId,
      name: body.name?.trim() || null,
      company: body.company?.trim() || null,
      job_title: body.job_title?.trim() || null,
      industry: body.industry?.trim() || null,
      niche: body.niche?.trim() || null,
      location: body.location?.trim() || null,
      followers: body.followers ?? null,
      commercial_goal: body.commercial_goal?.trim() || null,
      media_gap: body.media_gap?.trim() || null,
      priority: body.priority ?? "medium",
      followup_status: body.followup_status ?? "none",
      conversation_stage: "NEW_LEAD",
    });
    return ok({ lead, duplicate: duplicate.severity === "none" ? null : duplicate }, 201);
  } catch (error) {
    return handleError(error);
  }
}
