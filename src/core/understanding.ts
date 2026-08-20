import type { Message } from "@/lib/types";

/**
 * Service understanding is inferred from what the PROSPECT says, never from the
 * fact that we explained something.
 *
 * "We explained the service" is recorded separately as `service_explained`.
 * Explaining is an action we take; understanding is a state of the prospect that
 * only their own words can evidence.
 */

export type UnderstandingEvidence = {
  /** The prospect's words that justify the score. */
  quote: string;
  message_id: string | null;
  at: string | null;
  strength: "strong" | "moderate" | "weak";
  reason: string;
};

export type ConfusionSignal = { reason: string; quote: string; message_id: string | null };

export type UnderstandingAssessment = {
  /** 0 = not established, 1 = partial, 2 = clearly understands. */
  level: 0 | 1 | 2;
  evidence: UnderstandingEvidence[];
  /**
   * The prospect misunderstands WHAT is on offer — they think it is a podcast
   * booking, guest spot or free collaboration. This closes the call gate.
   */
  confusion: ConfusionSignal | null;
  /**
   * The prospect understands it is a service but not that it is PAID. A softer
   * state than confusion: it needs commercial clarity, not a premise correction.
   */
  commercial_clarity_needed: ConfusionSignal | null;
};

/**
 * Unambiguous service confusion: the prospect has the wrong model of WHAT this
 * is — a podcast booking, a guest spot, a free collaboration. These never depend
 * on context; correcting the premise is always the right move.
 */
const HARD_CONFUSION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bhow long is the (pod|podcast|episode|show)\b/i, reason: "Thinks they are being booked onto a podcast episode" },
  { re: /\bwhat (show|podcast) is this( for)?\b/i, reason: "Thinks this is a specific podcast booking" },
  { re: /\bwhich podcast\b/i, reason: "Thinks this is a specific podcast booking" },
  { re: /\bpodcast (invite|invitation)\b/i, reason: "Thinks this is a podcast invitation" },
  { re: /\b(is|are) (this|you) (a )?(collab|collaboration|partnership)\b/i, reason: "Thinks this is a collaboration" },
  { re: /\bis this a collab\b/i, reason: "Thinks this is a collaboration" },
  { re: /\b(be|being) (a guest|as a guest)\b/i, reason: "Thinks they are being invited as a guest" },
  { re: /\bcome on (to )?(the|your) (show|pod|podcast)\b/i, reason: "Thinks they are being invited onto a show" },
  { re: /\b(be|appear|feature) on (the|your) (show|pod|podcast)\b/i, reason: "Thinks they are being invited onto a show" },
  { re: /\bguest (spot|slot|appearance|invite|invitation)\b/i, reason: "Thinks they are being invited as a guest" },
  { re: /\binvit(e|ing) me\b/i, reason: "Thinks they are being invited onto something" },
  { re: /\bare you looking for guests\b/i, reason: "Thinks we are booking podcast guests" },
  { re: /\b(i )?(don'?t|do not|dont) pay to (be on|go on|appear|get on)\b/i, reason: "Believes we are asking them to pay a podcast host" },
  { re: /\bpay to (be on|go on|appear on) (a )?(pod|podcast|show)\b/i, reason: "Believes we are asking them to pay a podcast host" },
  { re: /\bfree\b.*\b(collab|feature|interview|opportunity)\b/i, reason: "Expects a free opportunity" },
  { re: /\bwhy would i pay to be a guest\b/i, reason: "Believes we are asking them to pay a podcast host" },
];

/**
 * Cost questions whose meaning depends on what we have already said.
 *
 * "Is there a cost?" from someone who has been told this is a service is a
 * buying question. The same words from someone who was pitched a vague
 * "opportunity" mean we never made the commercial model clear. Treating both as
 * podcast confusion — as this code previously did — makes the setter correct a
 * premise the prospect never held.
 */
const AMBIGUOUS_COST_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bis (this|it) free\b/i, reason: "Asked whether it is free — the commercial model is not clear yet" },
  { re: /\bis there (a|any) (cost|charge|fee)\b/i, reason: "Asked whether there is a cost — the commercial model is not clear yet" },
  { re: /\bdoes (this|it) cost\b/i, reason: "Asked whether it costs anything — the commercial model is not clear yet" },
  { re: /\bany (cost|charge|fee)s?\b/i, reason: "Asked about cost — the commercial model is not clear yet" },
];

/**
 * Explicit commercial/buying questions. These are positive evidence: you do not
 * ask what something costs unless you already know it is being sold.
 */
const COMMERCIAL_QUESTION_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bhow much (do|does|is|would|are|will)\b/i, reason: "Asked what it costs" },
  { re: /\bwhat do(es)? (you|it|this) (guys )?charge\b/i, reason: "Asked what we charge" },
  { re: /\bwhat.{0,20}\b(pricing|price|rates?|packages?|fees?|retainer)\b/i, reason: "Asked about pricing" },
  { re: /\bwhat does (this|it|working with you) (cost|involve|look like|entail)\b/i, reason: "Asked what the engagement involves" },
  { re: /\bwhat would (this|it) (cost|involve|look like)\b/i, reason: "Asked what the engagement involves" },
  { re: /\b(price|pricing|cost) range\b/i, reason: "Asked about a price range" },
  { re: /\bballpark\b/i, reason: "Asked for a ballpark price" },
  { re: /\bhow do you charge\b/i, reason: "Asked how we charge" },
];

/**
 * Strong evidence: the prospect frames us as a service provider, engages with the
 * actual mechanism, or asks commercial questions about scope/process/price.
 */
const STRONG_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\byou (help|work with) (your )?clients\b/i, reason: "Refers to us helping clients" },
  { re: /\byour clients\b/i, reason: "Refers to us having clients" },
  { re: /\b(what|how) (does|do|would) (this|it|the process|working together) (cost|work|look)\b/i, reason: "Asks about process or cost" },
  { re: /\bhow much (does|is|would|are)\b/i, reason: "Asks about price" },
  { re: /\b(what|how)\b[^?]*\b(pricing|price|rates?|packages?|fees?|retainer)\b/i, reason: "Asks about pricing" },
  { re: /\bwhat does (working with you|this) (look like|involve|entail)\b/i, reason: "Asks about scope of engagement" },
  { re: /\bwhat'?s (the|your) (process|scope|deliverable)/i, reason: "Asks about process or scope" },
  { re: /\b(written media|syndication|syndicated|search presence|seo|third[- ]party credibility|authority positioning)\b/i, reason: "Engages with the specific media/authority mechanism" },
  { re: /\bso you'?re (an?|the) (agency|service|company)\b/i, reason: "Names us as an agency/service" },
  { re: /\b(not|isn'?t) (just )?a (podcast|guest) (thing|invite|invitation)\b/i, reason: "Explicitly distinguishes this from a guest invitation" },
  { re: /\b(hire|retain|onboard|sign up with) you\b/i, reason: "Frames this as engaging us commercially" },
  { re: /\b(budget|investment|spend)\b.*\b(this|media|authority|pr)\b/i, reason: "Discusses budget for the service" },
];

/** Moderate: substantive engagement with the value, without explicit commercial framing. */
const MODERATE_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\b(credibility|authority|positioning)\b/i, reason: "Engages with the credibility/authority argument" },
  { re: /\b(press|coverage|media|publications?|articles?)\b.*\b(would|could|help|need|want|looking)\b/i, reason: "Discusses media in terms of their own need" },
  { re: /\b(google|search)\b.*\b(me|us|my name|nothing|comes up)\b/i, reason: "Engages with their search presence" },
  { re: /\bthat (would|could) help (me|us|my)\b/i, reason: "Connects the offer to their own goal" },
  { re: /\bi (need|want|could use)\b.*\b(credibility|press|media|authority|exposure)\b/i, reason: "States a media/authority need" },
];

/** Bare acknowledgement — explicitly NOT evidence of understanding. */
const WEAK_ACK = /^\s*(cool|sure|ok(ay)?|sounds good|great|nice|yeah|yes|yep|got it|interesting|awesome|perfect|thanks|thank you|👍|🙏)[\s.!]*$/i;

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Unambiguous service confusion only. Cost questions are deliberately excluded —
 * use `classifyCostQuestion` for those, because their meaning depends on whether
 * the commercial model has been explained.
 */
export function detectConfusion(text: string): { reason: string } | null {
  for (const { re, reason } of HARD_CONFUSION_PATTERNS) {
    if (re.test(text)) return { reason };
  }
  return null;
}

export type CostQuestionKind = "commercial_question" | "ambiguous_cost" | null;

/**
 * Classifies money talk.
 *
 * An explicit "how much do you charge?" is always a buying question. A bare
 * "is there a cost?" is ambiguous: it means the prospect is buying if we have
 * explained the service, and that we were unclear if we have not.
 */
export function classifyCostQuestion(text: string): { kind: CostQuestionKind; reason: string } {
  for (const { re, reason } of COMMERCIAL_QUESTION_PATTERNS) {
    if (re.test(text)) return { kind: "commercial_question", reason };
  }
  for (const { re, reason } of AMBIGUOUS_COST_PATTERNS) {
    if (re.test(text)) return { kind: "ambiguous_cost", reason };
  }
  return { kind: null, reason: "" };
}

/**
 * Scores how well the prospect understands the offer, using only their own messages.
 *
 * `serviceExplained` deliberately does NOT raise the score. It only affects how a
 * bare acknowledgement is recorded: without an explanation to acknowledge, "sure"
 * means nothing at all.
 */
export function assessUnderstanding(
  prospectMessages: Pick<Message, "id" | "message_text" | "sent_at">[],
  serviceExplained: boolean,
): UnderstandingAssessment {
  const evidence: UnderstandingEvidence[] = [];
  let confusion: ConfusionSignal | null = null;
  let commercialClarity: ConfusionSignal | null = null;
  let best: 0 | 1 | 2 = 0;
  let lastClarityIndex = -1;

  // Order matters: confusion only counts while it is the prospect's most recent
  // signal. Understanding expressed afterwards means the confusion was resolved.
  let lastConfusionIndex = -1;
  let lastUnderstandingIndex = -1;

  prospectMessages.forEach((msg, index) => {
    const text = normalize(msg.message_text);
    if (!text) return;

    const conf = detectConfusion(text);
    if (conf) {
      confusion = { reason: conf.reason, quote: text.slice(0, 200), message_id: msg.id ?? null };
      lastConfusionIndex = index;
      return;
    }

    // Money talk, resolved against what we have actually explained.
    const cost = classifyCostQuestion(text);
    if (cost.kind === "commercial_question") {
      evidence.push({ quote: text.slice(0, 200), message_id: msg.id ?? null, at: msg.sent_at ?? null, strength: "strong", reason: cost.reason });
      best = 2;
      lastUnderstandingIndex = index;
      return;
    }
    if (cost.kind === "ambiguous_cost") {
      if (serviceExplained) {
        // They know it is a service and are asking the price: a buying question.
        evidence.push({ quote: text.slice(0, 200), message_id: msg.id ?? null, at: msg.sent_at ?? null, strength: "strong", reason: `${cost.reason} (asked after the service was explained, so treated as a buying question)` });
        best = 2;
        lastUnderstandingIndex = index;
      } else {
        // We never made the commercial model clear. Not podcast confusion —
        // this needs commercial clarity, which is a different, softer move.
        commercialClarity = { reason: cost.reason, quote: text.slice(0, 200), message_id: msg.id ?? null };
        lastClarityIndex = index;
      }
      return;
    }

    let matched = false;
    for (const { re, reason } of STRONG_PATTERNS) {
      if (re.test(text)) {
        evidence.push({ quote: text.slice(0, 200), message_id: msg.id ?? null, at: msg.sent_at ?? null, strength: "strong", reason });
        best = 2;
        lastUnderstandingIndex = index;
        matched = true;
        break;
      }
    }
    if (matched) return;

    for (const { re, reason } of MODERATE_PATTERNS) {
      if (re.test(text)) {
        evidence.push({ quote: text.slice(0, 200), message_id: msg.id ?? null, at: msg.sent_at ?? null, strength: "moderate", reason });
        if (best < 1) best = 1;
        lastUnderstandingIndex = index;
        matched = true;
        break;
      }
    }
    if (matched) return;

    if (serviceExplained && WEAK_ACK.test(text)) {
      evidence.push({
        quote: text.slice(0, 200),
        message_id: msg.id ?? null,
        at: msg.sent_at ?? null,
        strength: "weak",
        reason: "Bare acknowledgement — does not establish understanding",
      });
    }
  });

  // Confusion collapses understanding only while it stands unanswered. A prospect
  // who asks "what show is this?" and then asks about pricing has been corrected;
  // one who understood earlier and is now confused has not.
  const confusionStands = lastConfusionIndex >= 0 && lastConfusionIndex > lastUnderstandingIndex;
  if (confusionStands) return { level: 0, evidence, confusion, commercial_clarity_needed: null };

  // Commercial clarity is a softer state: understanding is capped at partial
  // rather than zeroed, because they grasp the offer but not that it is paid.
  const clarityStands = lastClarityIndex >= 0 && lastClarityIndex > lastUnderstandingIndex;
  if (clarityStands) {
    return { level: Math.min(best, 1) as 0 | 1, evidence, confusion: null, commercial_clarity_needed: commercialClarity };
  }

  return { level: best, evidence, confusion: null, commercial_clarity_needed: null };
}

/** True when the prospect's latest message specifically shows confusion. */
export function latestMessageShowsConfusion(text: string): boolean {
  return detectConfusion(text) !== null;
}
