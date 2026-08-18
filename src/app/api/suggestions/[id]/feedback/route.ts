import { applyExchangeToMemory } from "@/core/memory";
import { fail, handleError, ok, readJson } from "@/lib/api";
import { requireAuth } from "@/lib/auth";
import { getStore } from "@/lib/store";
import { SUGGESTION_FEEDBACK, type SuggestionFeedback } from "@/lib/types";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type Body = {
  feedback: SuggestionFeedback;
  final_message_sent?: string | null;
  note?: string | null;
  /** When true, the message is also appended to the thread as a sent setter message. */
  append_to_thread?: boolean;
  lead_id?: string;
};

/** Records Used / Edited / Rejected against a suggestion, closing the feedback loop. */
export async function POST(request: Request, { params }: Params) {
  const denied = await requireAuth();
  if (denied) return denied;

  try {
    const { id } = await params;
    const body = await readJson<Body>(request);

    if (!SUGGESTION_FEEDBACK.includes(body.feedback)) {
      return fail(`feedback must be one of: ${SUGGESTION_FEEDBACK.join(", ")}`);
    }
    const finalMessage = body.final_message_sent?.trim() || null;
    if (body.feedback !== "rejected" && !finalMessage) {
      return fail("The message that was actually sent is required for Used and Edited");
    }

    const store = getStore();
    const suggestion = await store.recordFeedback(id, {
      feedback: body.feedback,
      final_message_sent: finalMessage,
      note: body.note ?? null,
    });

    if (body.append_to_thread && finalMessage) {
      await store.appendMessages(suggestion.lead_id, [
        {
          sender: "setter",
          message_text: finalMessage,
          sent_by_ai: body.feedback === "used",
          ai_suggestion_id: suggestion.id,
        },
      ]);

      // The exchange really happened, so permanent memory advances with it.
      const memory = await store.getMemory(suggestion.lead_id);
      await store.upsertMemory(
        suggestion.lead_id,
        applyExchangeToMemory(memory, suggestion.lead_id, {
          strategy: suggestion.strategy,
          sentMessage: finalMessage,
        }),
      );
    }

    return ok({ suggestion });
  } catch (error) {
    return handleError(error);
  }
}
