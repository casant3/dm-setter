import { getStore } from "@/lib/store";
import { fail, handleError, ok, readJson } from "@/lib/api";
import type { NewMessageInput, Sender } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const SENDERS: Sender[] = ["setter", "prospect", "system"];

export async function GET(_request: Request, { params }: Params) {
  try {
    const { id } = await params;
    return ok({ messages: await getStore().listMessages(id) });
  } catch (error) {
    return handleError(error);
  }
}

export async function POST(request: Request, { params }: Params) {
  try {
    const { id } = await params;
    const body = await readJson<{ messages?: NewMessageInput[] } & NewMessageInput>(request);
    const incoming = body.messages ?? [body];

    const clean: NewMessageInput[] = [];
    for (const m of incoming) {
      const text = String(m?.message_text ?? "").trim();
      if (!text) return fail("Every message needs text");
      if (!SENDERS.includes(m.sender)) return fail(`Unknown sender: ${String(m?.sender)}`);
      clean.push({
        sender: m.sender,
        message_text: text,
        sent_at: m.sent_at,
        sent_by_ai: m.sent_by_ai ?? false,
        ai_suggestion_id: m.ai_suggestion_id ?? null,
      });
    }
    if (clean.length === 0) return fail("No messages supplied");

    const store = getStore();
    if (!(await store.getLead(id))) return fail("Lead not found", 404);
    return ok({ messages: await store.appendMessages(id, clean) }, 201);
  } catch (error) {
    return handleError(error);
  }
}
