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

export type UnderstandingAssessment = {
  /** 0 = not established, 1 = partial, 2 = clearly understands. */
  level: 0 | 1 | 2;
  evidence: UnderstandingEvidence[];
  /** Set when the prospect reveals they misunderstand what is on offer. */
  confusion: { reason: string; quote: string; message_id: string | null } | null;
};

/** Phrases that reveal the prospect thinks this is a guest spot, freebie or collab. */
const CONFUSION_PATTERNS: { re: RegExp; reason: string }[] = [
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
  { re: /\bis (this|it) free\b/i, reason: "Unclear whether this is a commercial service" },
  { re: /\bis there (a|any) cost\b/i, reason: "Unclear whether this is a commercial service" },
  { re: /\bfree\b.*\b(collab|feature|interview|opportunity)\b/i, reason: "Expects a free opportunity" },
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

export function detectConfusion(text: string): { reason: string } | null {
  for (const { re, reason } of CONFUSION_PATTERNS) {
    if (re.test(text)) return { reason };
  }
  return null;
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
  let confusion: UnderstandingAssessment["confusion"] = null;
  let best: 0 | 1 | 2 = 0;

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
  if (confusionStands) return { level: 0, evidence, confusion };

  return { level: best, evidence, confusion: null };
}

/** True when the prospect's latest message specifically shows confusion. */
export function latestMessageShowsConfusion(text: string): boolean {
  return detectConfusion(text) !== null;
}
