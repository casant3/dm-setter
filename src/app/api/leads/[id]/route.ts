import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { FOLLOWUP_STATUSES, PRIORITIES, type Lead } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Only these lead fields may be changed from the browser. */
const EDITABLE = new Set<keyof Lead>([
  "name",
  "company",
  "job_title",
  "industry",
  "niche",
  "followers",
  "location",
  "commercial_goal",
  "media_gap",
  "media_experience",
  "authority_level",
  "conversation_stage",
  "interest_level",
  "lead_status",
  "priority",
  "followup_status",
  "followup_note",
  "next_followup_at",
  "booked_call",
  "booked_call_at",
  "outcome",
]);

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const store = getStore();
    const lead = await store.getLead(id);
    if (!lead) return fail("Lead not found", 404);

    const [messages, memory, events, suggestions] = await Promise.all([
      store.listMessages(id),
      store.getMemory(id),
      store.listEvents(id, 12),
      store.listSuggestions(id),
    ]);
    return ok({ lead, messages, memory, events, suggestions });
  } catch (error) {
    return handleError(error);
  }
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await readJson<Partial<Lead>>(request);

    const patch: Partial<Lead> = {};
    for (const [key, value] of Object.entries(body)) {
      if (EDITABLE.has(key as keyof Lead)) (patch as Record<string, unknown>)[key] = value;
    }
    if (Object.keys(patch).length === 0) return fail("No editable fields in the request");
    if (patch.priority && !PRIORITIES.includes(patch.priority)) return fail("Unknown priority");
    if (patch.followup_status && !FOLLOWUP_STATUSES.includes(patch.followup_status)) {
      return fail("Unknown follow-up status");
    }

    const store = getStore();
    if (!(await store.getLead(id))) return fail("Lead not found", 404);
    return ok({ lead: await store.updateLead(id, patch) });
  } catch (error) {
    return handleError(error);
  }
}
