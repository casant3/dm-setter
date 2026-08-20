import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { PRIORITIES, type NewLeadInput } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const store = getStore();
    return ok({ leads: await store.listLeads(), store_mode: store.mode });
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
    if (await store.getLeadByHandle(handle)) return fail(`@${handle} is already in the pipeline`, 409);

    const lead = await store.createLead({
      instagram_handle: handle,
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
    return ok({ lead }, 201);
  } catch (error) {
    return handleError(error);
  }
}
