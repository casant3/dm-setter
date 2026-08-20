import type { Message } from "@/lib/types";

/**
 * Not every "I'm good thanks" means the same thing.
 *
 * Someone who declines before they have any idea what we do has not rejected the
 * offer — they have declined a vague approach. Someone who declines after
 * understanding it has, and pushing further makes us a persistence bot. The
 * difference is whether the service was explained *and* understood at the time
 * they said it.
 */

export const BRUSHOFF_KINDS = [
  "uninformed_brushoff",
  "informed_rejection",
  "timing_objection",
  "true_not_interested",
  "none",
] as const;
export type BrushOffKind = (typeof BRUSHOFF_KINDS)[number];

export type BrushOffAssessment = {
  kind: BrushOffKind;
  quote: string | null;
  message_id: string | null;
  reason: string;
  /** May we make one short clarification move? False once they have understood. */
  may_clarify_once: boolean;
  /** True when the right thing to do is stop. */
  should_disengage: boolean;
};

/** Soft declines — meaning depends entirely on what they knew at the time. */
const SOFT_DECLINE = [
  /\bi'?m (all )?(good|set|fine|ok(ay)?)\b/i,
  /\bno (thanks|thank you)\b/i,
  /\bnot (for me|interested|really)\b/i,
  /\ball good\b/i,
  /\bi'?ll pass\b/i,
  /\bwe'?re (good|set|fine|covered)\b/i,
];

/** Explicit, informed refusal — no ambiguity about what is being refused. */
const HARD_DECLINE = [
  /\bnot interested\b.{0,40}\b(thanks|at all|in this|sorry)\b/i,
  /\b(please )?(stop|don'?t) (messaging|contacting|reaching out)\b/i,
  /\bremove me\b/i,
  /\bnot looking (for|to)\b.{0,30}\b(this|that|anything)\b/i,
  /\bwe don'?t (do|use|need) (this|that|pr|agencies)\b/i,
  /\bi'?m not paying\b/i,
  /\bno interest\b/i,
];

/** Deferrals — a live lead with bad timing, not a rejection. */
const TIMING = [
  /\bnot (right now|at the moment|this (month|quarter|year))\b/i,
  /\b(maybe|circle back|reach out|hit me up) (later|next (month|quarter|year)|in a few)\b/i,
  /\btoo (busy|slammed|swamped)\b/i,
  /\b(after|once) (the )?(launch|raise|summer|holidays|new year|q[1-4])\b/i,
  /\bbad timing\b/i,
  /\bcheck back\b/i,
];

function firstMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

/**
 * Classifies the prospect's latest decline, if any.
 *
 * `understandsService` must come from evidence in the prospect's own words —
 * not from the fact that we explained something — otherwise every brush-off
 * would be treated as informed simply because we had talked a lot.
 */
export function classifyBrushOff(
  latest: Pick<Message, "id" | "message_text"> | null,
  context: { understandsService: boolean; serviceExplained: boolean },
): BrushOffAssessment {
  const text = (latest?.message_text ?? "").trim();
  const none: BrushOffAssessment = {
    kind: "none",
    quote: null,
    message_id: null,
    reason: "No decline detected in the latest message.",
    may_clarify_once: false,
    should_disengage: false,
  };
  if (!text) return none;

  const base = { quote: text.slice(0, 200), message_id: latest?.id ?? null };

  if (firstMatch(text, HARD_DECLINE)) {
    return {
      ...base,
      kind: "true_not_interested",
      reason: "Explicit refusal. Respect it and stop.",
      may_clarify_once: false,
      should_disengage: true,
    };
  }

  if (firstMatch(text, TIMING)) {
    return {
      ...base,
      kind: "timing_objection",
      reason: "A deferral, not a refusal. Acknowledge, agree a concrete time to revisit, and stop selling.",
      may_clarify_once: false,
      should_disengage: false,
    };
  }

  if (firstMatch(text, SOFT_DECLINE)) {
    if (context.understandsService) {
      return {
        ...base,
        kind: "informed_rejection",
        reason: "They declined after showing they understand what this is. Respect it.",
        may_clarify_once: false,
        should_disengage: true,
      };
    }
    return {
      ...base,
      kind: "uninformed_brushoff",
      reason: context.serviceExplained
        ? "They declined without ever showing they understood the offer. One short, non-pushy clarification is allowed."
        : "They declined before we explained anything. One short, non-pushy clarification is allowed.",
      may_clarify_once: true,
      should_disengage: false,
    };
  }

  return none;
}

/**
 * Whether the one permitted clarification has already been spent.
 *
 * Counted from the messages we sent after the brush-off, so the allowance cannot
 * be re-used every turn.
 */
export function clarificationAlreadyUsed(messages: Message[], brushOffMessageId: string | null): boolean {
  if (!brushOffMessageId) return false;
  const index = messages.findIndex((m) => m.id === brushOffMessageId);
  if (index === -1) return false;
  return messages.slice(index + 1).some((m) => m.sender === "setter");
}
