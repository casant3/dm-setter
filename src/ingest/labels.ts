import { detectConfusion } from "@/core/understanding";
import { messageExplainsService } from "@/core/memory";
import type { TranscribedMessage } from "@/ingest/transcribe";
import type { OutcomeTier } from "@/lib/types";

/**
 * Structured labels derived from a verified historical conversation.
 *
 * These make retrieval matchable on situation rather than wording alone, and
 * they are what let the system say *why* a conversation went the way it did —
 * including the case the corpus taught us about: a booked call that was never
 * really qualified.
 */

export type ConversationLabels = {
  opener_type: string;
  message_count: number;
  setter_message_count: number;
  prospect_message_count: number;
  qualification_questions: string[];
  commercial_goal_discovered: boolean;
  media_gap_identified: boolean;
  value_props_used: string[];
  credibility_introduced: boolean;
  service_explained: boolean;
  service_understanding_evidence: string[];
  objections: string[];
  buying_signals: string[];
  service_confusion: boolean;
  confusion_resolved: boolean | null;
  cta_used: boolean;
  messages_before_cta: number | null;
  premature_cta: boolean;
  quality_score: number;
  successful_angle: string | null;
  failed_angle: string | null;
};

const VALUE_PROPS: { re: RegExp; label: string }[] = [
  { re: /\bpodcast(s)?\b/i, label: "podcast placement" },
  { re: /\b(written media|article|publication|press|magazine)\b/i, label: "written media" },
  { re: /\bsyndicat/i, label: "syndication" },
  { re: /\b(seo|search|google)\b/i, label: "search presence" },
  { re: /\b(credibility|authority|third[- ]party)\b/i, label: "third-party credibility" },
  { re: /\bpositioning\b/i, label: "positioning" },
];

const CTA_PATTERNS = [/\bavo\b/i, /\b(20|15|30) min(ute)?s?\b/i, /\b(jump on|hop on|grab) a (call|chat)\b/i, /\bbook (a|in)\b/i, /\bcalendar\b/i];

const OBJECTION_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b(too expensive|can'?t afford|budget)\b/i, label: "price" },
  { re: /\bnot (interested|right now|a priority)\b/i, label: "not interested" },
  { re: /\b(busy|no time|swamped)\b/i, label: "timing" },
  { re: /\b(already (have|working with)|we do this in[- ]house)\b/i, label: "already covered" },
  { re: /\b(don'?t|do not) pay\b/i, label: "will not pay" },
  { re: /\bneed to think\b/i, label: "needs to think" },
];

const BUYING_SIGNAL_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bhow much|pricing|cost|rates?\b/i, label: "asked about price" },
  { re: /\bwhat does (this|working with you) look like\b/i, label: "asked what it involves" },
  { re: /\b(send|share) (me )?(more )?(info|details)\b/i, label: "asked for information" },
  { re: /\b(interested|keen|up for)\b/i, label: "stated interest" },
];

function classifyOpener(first: TranscribedMessage | undefined): string {
  if (!first) return "unknown";
  const t = first.text;
  if (/\?$/.test(t.trim())) return "question";
  if (/\b(saw|loved|watched|read|listened)\b/i.test(t)) return "specific compliment";
  if (/\bcongrat/i.test(t)) return "congratulations";
  if (t.length < 40) return "short opener";
  return "statement";
}

/**
 * Derives labels from the transcript plus what the board says happened.
 *
 * `tier` is the downstream truth and is what makes `premature_cta` meaningful:
 * a CTA that landed a call which then evaporated was premature, whatever it
 * looked like at the time.
 */
export function labelConversation(messages: TranscribedMessage[], tier: OutcomeTier): ConversationLabels {
  const setterMsgs = messages.filter((m) => m.sender === "setter");
  const prospectMsgs = messages.filter((m) => m.sender === "prospect");

  const qualificationQuestions = setterMsgs
    .filter((m) => m.text.includes("?"))
    .map((m) => m.text.trim())
    .slice(0, 12);

  const setterText = setterMsgs.map((m) => m.text).join(" ");
  const prospectText = prospectMsgs.map((m) => m.text).join(" ");

  const valueProps = VALUE_PROPS.filter((v) => v.re.test(setterText)).map((v) => v.label);

  let ctaIndex: number | null = null;
  messages.forEach((m, i) => {
    if (ctaIndex === null && m.sender === "setter" && CTA_PATTERNS.some((re) => re.test(m.text))) ctaIndex = i;
  });

  // Confusion, and whether the setter actually corrected it afterwards.
  let confusionIndex: number | null = null;
  messages.forEach((m, i) => {
    if (m.sender === "prospect" && detectConfusion(m.text)) confusionIndex = i;
  });
  const confusionResolved =
    confusionIndex === null
      ? null
      : messages.slice(confusionIndex + 1).some((m) => m.sender === "setter" && messageExplainsService(m.text));

  // Stems, not exact words: "launching" and "raising" are the common forms.
  const commercialGoal =
    /\b(launch\w*|rais\w*|sell\w*|grow\w*|scal\w*|build\w*|open\w*|hir\w*|expand\w*)\b/i.test(prospectText) ||
    /\b(round|series [a-c]|funding|programme|program|course|book|product)\b/i.test(prospectText);
  const mediaGap = /\b(nothing|not much|don'?t have|no press|never done)\b/i.test(prospectText);

  const understandingEvidence = prospectMsgs
    .filter((m) =>
      /\b(your clients|you help clients|pricing|price|cost|rates?|process|scope|written media|syndication|retainer)\b/i.test(m.text) ||
      /\bwhat (does|would) working with you\b/i.test(m.text) ||
      /\bwhat does (this|it) (look like|involve)\b/i.test(m.text))
    .map((m) => m.text.trim())
    .slice(0, 5);

  const objections = OBJECTION_PATTERNS.filter((o) => o.re.test(prospectText)).map((o) => o.label);
  const buyingSignals = BUYING_SIGNAL_PATTERNS.filter((b) => b.re.test(prospectText)).map((b) => b.label);

  const serviceExplained = setterMsgs.some((m) => messageExplainsService(m.text));

  // A CTA is premature when it went out before the basics were established, or
  // when the downstream outcome shows the booking was hollow.
  const prematureCta =
    ctaIndex !== null &&
    (!commercialGoal || !serviceExplained || (confusionIndex !== null && !confusionResolved) || tier === "E" || tier === "F");

  const quality = scoreQuality({
    tier,
    commercialGoal,
    mediaGap,
    serviceExplained,
    understanding: understandingEvidence.length > 0,
    prematureCta,
    confusionUnresolved: confusionIndex !== null && !confusionResolved,
  });

  return {
    opener_type: classifyOpener(messages[0]),
    message_count: messages.length,
    setter_message_count: setterMsgs.length,
    prospect_message_count: prospectMsgs.length,
    qualification_questions: qualificationQuestions,
    commercial_goal_discovered: commercialGoal,
    media_gap_identified: mediaGap,
    value_props_used: valueProps,
    credibility_introduced: /\b(we'?ve (worked|placed)|our clients|featured in|as seen)\b/i.test(setterText),
    service_explained: serviceExplained,
    service_understanding_evidence: understandingEvidence,
    objections,
    buying_signals: buyingSignals,
    service_confusion: confusionIndex !== null,
    confusion_resolved: confusionResolved,
    cta_used: ctaIndex !== null,
    messages_before_cta: ctaIndex,
    premature_cta: prematureCta,
    quality_score: quality,
    successful_angle: tier === "A" || tier === "B" ? (valueProps[0] ?? null) : null,
    failed_angle: tier === "E" || tier === "F" ? (prematureCta ? "CTA before qualification" : (objections[0] ?? null)) : null,
  };
}

/**
 * Quality is grounded in the downstream outcome first, then adjusted by how the
 * conversation was actually run. This is what stops a booked-but-doomed call
 * from ranking as a good example.
 */
function scoreQuality(input: {
  tier: OutcomeTier;
  commercialGoal: boolean;
  mediaGap: boolean;
  serviceExplained: boolean;
  understanding: boolean;
  prematureCta: boolean;
  confusionUnresolved: boolean;
}): number {
  const base: Record<OutcomeTier, number> = { A: 4, B: 3, C: 2, D: 1.5, E: 1, F: 1 };
  let score = base[input.tier];

  if (input.commercialGoal) score += 0.4;
  if (input.mediaGap) score += 0.3;
  if (input.serviceExplained) score += 0.3;
  if (input.understanding) score += 0.5;
  if (input.prematureCta) score -= 0.8;
  if (input.confusionUnresolved) score -= 0.8;

  return Number(Math.max(0, Math.min(5, score)).toFixed(2));
}
