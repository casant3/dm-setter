import type { LeadMemory, Strategy } from "@/lib/types";

/**
 * Maintains permanent lead memory after an exchange actually happens.
 *
 * This is deliberately deterministic rather than another model call: it records
 * what is already known for certain — the question that was just asked, whether
 * the service was explained, how the prospect's understanding scored, and what
 * the current strategy is. Richer summarisation stays a human/model job.
 */

export type ExchangeInput = {
  strategy: Strategy;
  /** The message the setter actually sent. */
  sentMessage: string;
  /** The prospect's latest message, when there was one. */
  prospectMessage?: string;
};

function asStrings(value: unknown[] | undefined | null): string[] {
  return (value ?? []).map((v) => String(v));
}

/** Case-insensitive append that leaves the existing order intact. */
function addUnique(list: string[], entry: string): string[] {
  const trimmed = entry.trim();
  if (!trimmed) return list;
  const seen = list.some((v) => v.trim().toLowerCase() === trimmed.toLowerCase());
  return seen ? list : [...list, trimmed];
}

/** Splits a DM into the questions it asks, so they are never asked twice. */
export function extractQuestions(message: string): string[] {
  return message
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith("?") && s.length > 8);
}

export function applyExchangeToMemory(
  memory: LeadMemory | null,
  leadId: string,
  input: ExchangeInput,
): Partial<LeadMemory> & { lead_id: string } {
  const { strategy, sentMessage, prospectMessage } = input;

  let questions = asStrings(memory?.questions_already_asked);
  for (const q of extractQuestions(sentMessage)) questions = addUnique(questions, q);

  let offers = asStrings(memory?.offers_explained);
  if (strategy.should_explain_service || strategy.service_confusion) {
    offers = addUnique(offers, "Explained that this is a paid professional media/authority service");
  }

  let ctas = asStrings(memory?.ctas_already_used);
  if (strategy.call_ready) ctas = addUnique(ctas, "Offered a call with Avo");

  let objections = asStrings(memory?.objections);
  if (prospectMessage && strategy.service_confusion && strategy.confusion_reason) {
    objections = addUnique(objections, strategy.confusion_reason);
  }

  // Understanding only ratchets up once the service has actually been explained;
  // a confused prospect resets it, which is what re-opens the gate.
  const previous = memory?.service_understanding ?? 0;
  const service_understanding = strategy.service_confusion
    ? 0
    : Math.max(previous, strategy.qualification.service_understanding, strategy.should_explain_service ? 1 : 0);

  return {
    lead_id: leadId,
    questions_already_asked: questions,
    offers_explained: offers,
    ctas_already_used: ctas,
    objections,
    service_understanding: Math.min(2, service_understanding),
    current_strategy: strategy.next_objective,
    updated_at: new Date().toISOString(),
  };
}
