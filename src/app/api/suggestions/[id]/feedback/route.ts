import { recordExchange } from "@/core/agent";
import { observeEdit } from "@/core/coaching";
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

      // The exchange really happened, so permanent memory advances with it —
      // deterministically first, then the model-driven extraction pass.
      await recordExchange(store, suggestion.lead_id, suggestion.strategy, finalMessage);
    }

    // An edit is the operator saying "not like that, like this". What the edit
    // appears to mean is proposed as a rule — and stays inert until approved.
    let proposals = 0;
    if (body.feedback === "edited" && finalMessage) {
      const observations = observeEdit(suggestion.suggested_message, finalMessage);
      for (const observation of observations) {
        await store.createSetterPreference({
          setter_name: process.env.SETTER_VOICE || "Cassey",
          rule: observation.proposed_rule,
          applies_to: suggestion.strategy?.stage ?? null,
          source: "live_edit",
          status: "pending_review",
          priority: 0,
          evidence: { ...observation.evidence, suggestion_id: suggestion.id },
          approved_at: null,
        });
        proposals += 1;
      }
    }

    return ok({ suggestion, coaching_proposals: proposals });
  } catch (error) {
    return handleError(error);
  }
}
