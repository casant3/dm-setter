/**
 * Reading what the operator meant when they rejected a draft.
 *
 * The valuable half of a coaching history is not the message that was finally
 * approved — it is the sentence before it. "too long", "he already said that",
 * "build more value, no call yet" each name a specific fault, and the same fault
 * recurs across hundreds of conversations. This module turns that shorthand into
 * tags the retrieval layer can rank on.
 *
 * Deterministic patterns handle the phrasings the operator actually uses.
 * Anything else is marked as needing model judgement rather than guessed at, and
 * either way nothing here is applied until a person approves it.
 */

/** Why a draft was changed, or what was right about it. */
export const COACHING_TAGS = [
  // What was wrong.
  "too_long",
  "too_salesy",
  "too_corporate",
  "too_needy",
  "too_pushy",
  "repeated_question",
  "already_answered",
  "dead_end_statement",
  "premature_cta",
  "cta_too_late",
  "weak_value",
  "wrong_motivation",
  "money_frame_wrong",
  "overexplaining",
  "unnatural_intro",
  "bad_transition",
  "service_not_clear",
  "gave_up_too_early",
  // What was right.
  "good_progression",
  "good_value_build",
  "good_opener",
  "good_qualification",
  "good_objection_handling",
  "good_booking_transition",
  "human_natural_tone",
] as const;
export type CoachingTag = (typeof COACHING_TAGS)[number];

/** Tags that describe a fault, as opposed to praise. */
export const FAULT_TAGS: CoachingTag[] = COACHING_TAGS.filter((t) => !t.startsWith("good_") && t !== "human_natural_tone");

export type FeedbackKind = "criticism" | "approval" | "instruction" | "none";

export type FeedbackReading = {
  kind: FeedbackKind;
  tags: CoachingTag[];
  /** The operator's own words. */
  quote: string;
  /** "high" when a deterministic pattern matched; "low" when it was inferred. */
  confidence: "high" | "low";
  /**
   * True when this looks like feedback but no pattern explains it. The caller
   * may put it to a model; it is never assumed to mean anything on its own.
   */
  needs_model_judgement: boolean;
};

type Rule = { re: RegExp; tags: CoachingTag[] };

/**
 * Criticism, by fault.
 *
 * Written to catch the phrasing rather than the exact sentence: "he already said
 * that", "she already told you that", "they already answered that" are one rule.
 */
const CRITICISM: Rule[] = [
  { re: /\b(too long|shorten|cut it down|way too long|trim (this|it)|shorter)\b/i, tags: ["too_long"] },
  { re: /\b(too sales[yi]|sounds like a pitch|stop selling|too much of a pitch)\b/i, tags: ["too_salesy"] },
  { re: /\b(too )?(corporate|formal|stiff|robotic|like a bot|ai[- ]generated|chatgpt)\b/i, tags: ["too_corporate"] },
  { re: /\b(sound|make it sound|be) (more )?(human|natural|like me|normal)\b/i, tags: ["too_corporate", "human_natural_tone"] },
  { re: /\b(less needy|too needy|desperate|stop apolog|don'?t beg)\b/i, tags: ["too_needy"] },
  { re: /\b(too pushy|too aggressive|too hard|backing (him|her|them) into)\b/i, tags: ["too_pushy"] },
  {
    re: /\b(he|she|they|.{1,20})\s+already (said|told|mentioned|answered|covered)\b/i,
    tags: ["already_answered", "repeated_question"],
  },
  { re: /\bwe already (asked|know|covered)\b/i, tags: ["already_answered", "repeated_question"] },
  {
    re: /\b(you'?re )?asking (the same|that) (thing|question) again\b|\b(same|repeat) question\b|\bdon'?t ask (that|it) again\b/i,
    tags: ["repeated_question"],
  },
  { re: /\b(he|she|they)('?s| is| are)? (already )?(down|open|keen|interested)\b.{0,30}\b(to hear|hear it out|opportunities)?\b/i, tags: ["already_answered"] },
  {
    re: /\b(this|it|that)('?s| is) (just )?a statement\b|\bwhere (is this|will this) lead|\bthen where\b|\bleads nowhere\b|\bdead end\b/i,
    tags: ["dead_end_statement"],
  },
  {
    re: /\b(no call yet|too early for (a|the) call|don'?t (ask for|push) the call|not ready for a call|too soon to book)\b/i,
    tags: ["premature_cta"],
  },
  { re: /\bbuild (more|the) value\b|\bmore value first\b|\bvalue first\b/i, tags: ["weak_value", "premature_cta"] },
  { re: /\b(weak|generic|vague|fluffy) (value|angle|pitch|reason)\b|\bbe more specific\b|\btoo generic\b/i, tags: ["weak_value"] },
  { re: /\b(ask for the call|why (didn'?t|haven'?t) you (ask|book)|should have (asked|booked)|push (for )?the call now)\b/i, tags: ["cta_too_late"] },
  { re: /\b(don'?t (make (this|it) about|mention) money|not about (the )?money|drop the (money|revenue|roi) (angle|framing))\b/i, tags: ["money_frame_wrong", "wrong_motivation"] },
  { re: /\b(doesn'?t seem|isn'?t) (like )?(the )?money (hungry|motivated|driven)\b/i, tags: ["money_frame_wrong", "wrong_motivation"] },
  { re: /\b(wrong (angle|frame|motivation)|that'?s not what (he|she|they) cares? about|missing what (he|she|they) wants?)\b/i, tags: ["wrong_motivation"] },
  { re: /\b(over[- ]?explain|too much detail|don'?t explain so much|waffl|rambl)\w*\b/i, tags: ["overexplaining"] },
  { re: /\b(bad|weak|awkward) (opener|opening|intro)\b|\bdon'?t open with\b|\bthat intro\b/i, tags: ["unnatural_intro"] },
  { re: /\b(jump|jumps|jumping) (too fast|straight)\b|\b(bad|awkward|no) transition\b|\bdoesn'?t flow\b/i, tags: ["bad_transition"] },
  {
    re: /\b(he|she|they) (doesn'?t|don'?t) (even )?(know|understand) what we do\b|\bservice isn'?t clear\b|\bmake (the )?(service|offer) clear(er)?\b/i,
    tags: ["service_not_clear"],
  },
  { re: /\b(don'?t give up|too early to drop|keep going|don'?t leave it there|why are you giving up)\b/i, tags: ["gave_up_too_early"] },
];

/** Approval. Only these make a draft an approved example. */
const APPROVAL: Rule[] = [
  { re: /\b(this is (better|good|great|perfect|it)|much better|that'?s better)\b/i, tags: ["good_progression"] },
  { re: /\b(send (this|it)|use (this|that)|go with (this|that)|ship it)\b/i, tags: [] },
  { re: /\b(i like (this|that|it)|love (this|that|it)|nice one|that works|yes that'?s the one)\b/i, tags: [] },
  { re: /\b(perfect|exactly|spot on|nailed it)\b/i, tags: [] },
];

/** Praise that also names what was good, so the tag survives the import. */
const PRAISE_DETAIL: Rule[] = [
  { re: /\b(good|nice|great) (value|angle)\b/i, tags: ["good_value_build"] },
  { re: /\b(good|nice|great) (opener|opening)\b/i, tags: ["good_opener"] },
  { re: /\b(good|nice) (question|qualification)\b/i, tags: ["good_qualification"] },
  { re: /\b(good|nice) (objection|handling|comeback)\b/i, tags: ["good_objection_handling"] },
  { re: /\b(good|nice|smooth) (transition|booking|close)\b/i, tags: ["good_booking_transition"] },
  { re: /\b(sounds|reads) (human|natural|like me)\b/i, tags: ["human_natural_tone"] },
];

/** An instruction for the next draft rather than a verdict on this one. */
const INSTRUCTION = /\b(try|write|make it|rewrite|redo|give me|do it|now)\b/i;

/**
 * Long messages are new context, not feedback on the last draft.
 *
 * Real feedback is short — "too long", "he already said that". A paragraph is a
 * brief for the next message, and briefs routinely contain phrases like "he
 * already told me he has no press", which would otherwise read as criticism.
 */
const MAX_FEEDBACK_WORDS = 40;

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function collect(rules: Rule[], text: string): { matched: boolean; tags: CoachingTag[] } {
  const tags: CoachingTag[] = [];
  let matched = false;
  for (const rule of rules) {
    if (!rule.re.test(text)) continue;
    matched = true;
    for (const tag of rule.tags) if (!tags.includes(tag)) tags.push(tag);
  }
  return { matched, tags };
}

/**
 * Reads one operator message as feedback on the draft immediately before it.
 *
 * Criticism is checked before approval, because "this is better but still too
 * long" is a rejection with a compliment attached, not an approval.
 */
export function readOperatorFeedback(text: string): FeedbackReading {
  const quote = text.trim();
  const none: FeedbackReading = {
    kind: "none",
    tags: [],
    quote,
    confidence: "high",
    needs_model_judgement: false,
  };
  if (!quote) return none;

  // Anything this long is a new brief, not a verdict.
  const long = wordCount(quote) > MAX_FEEDBACK_WORDS;

  const criticism = collect(CRITICISM, quote);
  if (criticism.matched && !long) {
    return { kind: "criticism", tags: criticism.tags, quote, confidence: "high", needs_model_judgement: false };
  }

  const approval = collect(APPROVAL, quote);
  if (approval.matched && !long) {
    const detail = collect(PRAISE_DETAIL, quote);
    const tags = [...new Set([...approval.tags, ...detail.tags])];
    return { kind: "approval", tags, quote, confidence: "high", needs_model_judgement: false };
  }

  if (long) return none;

  // Short, reactive, and unexplained by any pattern: it probably means
  // something, but not something this code is entitled to decide.
  if (wordCount(quote) <= 12) {
    return {
      kind: INSTRUCTION.test(quote) ? "instruction" : "none",
      tags: [],
      quote,
      confidence: "low",
      needs_model_judgement: true,
    };
  }

  return none;
}

/**
 * Merges a model's reading of an ambiguous message with the deterministic one.
 *
 * The model may only fill in a reading the patterns could not produce; it can
 * never overturn a high-confidence pattern match, and every tag it offers must
 * be one of the known tags.
 */
export function applyModelReading(
  deterministic: FeedbackReading,
  model: { kind: FeedbackKind; tags: string[] } | null,
): FeedbackReading {
  if (!model || !deterministic.needs_model_judgement) return deterministic;
  const tags = model.tags.filter((t): t is CoachingTag => (COACHING_TAGS as readonly string[]).includes(t));
  if (model.kind === "none") return { ...deterministic, needs_model_judgement: false };
  return { ...deterministic, kind: model.kind, tags, confidence: "low", needs_model_judgement: false };
}
