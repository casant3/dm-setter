import type { CoachingTag } from "@/core/operator-feedback";
import type { CoachingExample, SetterPreference } from "@/lib/types";

/**
 * How Cassey actually wants this written.
 *
 * The setter already learns strategy from historical winners and tone from
 * historical voice examples. Neither of those can carry an instruction — "stop
 * opening with 'quick one'", "never mention price before he does" — and neither
 * updates when the operator changes their mind.
 *
 * This layer carries those, in a strict precedence order, so that when two
 * sources disagree the setter knows which one wins. Nothing enters it
 * automatically: everything learned from live edits or imported from elsewhere
 * arrives as a proposal a human has to approve.
 */

export const COACHING_PRIORITY = [
  "explicit_rule",
  "approved_example",
  "approved_live_message",
  "historical_voice",
  "team_strategy",
  "generic_prompt",
] as const;
export type CoachingTier = (typeof COACHING_PRIORITY)[number];

export const TIER_LABELS: Record<CoachingTier, string> = {
  explicit_rule: "1. Explicit rule from Cassey — overrides everything below",
  approved_example: "2. Coaching example Cassey approved — follow its shape",
  approved_live_message: "3. Messages Cassey actually sent — the live voice",
  historical_voice: "4. Cassey's historical messages — tone reference",
  team_strategy: "5. Team strategy from winning conversations — approach, not wording",
  generic_prompt: "6. These general instructions — the fallback when nothing above applies",
};

export type ApprovedLiveMessage = {
  sent: string;
  stage: string | null;
  at: string;
  /** True when Cassey rewrote the suggestion rather than sending it as-is. */
  edited: boolean;
};

/** One piece of coaching, ready for the prompt. */
export type CoachingItem = {
  kind: string;
  situation: string;
  their_message: string | null;
  /** The reply to follow, when one was approved. */
  reply: string | null;
  /** The draft that was rejected, when this came from a correction. */
  avoid: string | null;
  /** Why it was rejected, in Cassey's words. */
  because: string | null;
  why: string | null;
  tags: string[];
  /** Why this example was selected for this message. */
  relevance: string[];
};

export type CoachingLayer = {
  rules: string[];
  examples: CoachingItem[];
  live_messages: ApprovedLiveMessage[];
  precedence: string[];
  note: string;
  /** How many approved examples existed before ranking narrowed them. */
  considered: number;
};

/**
 * What the setter is about to do, used to pick coaching that applies.
 *
 * Dumping every approved rule and example into every prompt buries the relevant
 * one: advice about building value before a call is exactly wrong in the message
 * that books it. Coaching is ranked against the situation instead.
 */
export type CoachingSituation = {
  move?: string | null;
  stage?: string | null;
  temperature?: string | null;
  brush_off?: string | null;
  motivation?: string | null;
  avoid_money_framing?: boolean;
  booking_state?: string | null;
  service_confusion?: boolean;
};

/** Tags worth preferring for each move. */
const MOVE_TAGS: Record<string, CoachingTag[]> = {
  cold_opener: ["good_opener", "unnatural_intro", "too_salesy"],
  ask_discovery: ["good_qualification", "repeated_question", "already_answered", "dead_end_statement"],
  build_value: ["good_value_build", "weak_value", "premature_cta", "wrong_motivation", "overexplaining"],
  test_interest: ["good_qualification", "dead_end_statement", "too_needy"],
  offer_call: ["good_booking_transition", "cta_too_late", "too_needy", "too_pushy"],
  arrange_logistics: ["good_booking_transition", "too_pushy", "overexplaining"],
  correct_premise: ["service_not_clear", "overexplaining"],
  clarify_commercial: ["service_not_clear", "money_frame_wrong"],
  clarify_after_brushoff: ["gave_up_too_early", "too_pushy", "service_not_clear"],
  respect_rejection: ["too_pushy", "too_needy"],
  park_and_agree_time: ["too_pushy", "gave_up_too_early"],
  hold: [],
};

/** Tags worth preferring at each temperature. */
const TEMPERATURE_TAGS: Record<string, CoachingTag[]> = {
  guarded: ["too_pushy", "too_salesy", "too_needy", "human_natural_tone", "premature_cta", "too_long"],
  neutral: ["human_natural_tone", "good_qualification"],
  engaged: ["good_value_build", "good_progression"],
  warm: ["good_value_build", "good_progression", "cta_too_late"],
  high_intent: ["good_booking_transition", "cta_too_late"],
};

/** How many examples reach the prompt. More than this and none of them land. */
export const MAX_COACHING_EXAMPLES = 4;

function conditionScore(example: CoachingExample, situation: CoachingSituation): { score: number; reasons: string[] } {
  const condition = example.applies_when;
  if (!condition) return { score: 0, reasons: [] };

  const reasons: string[] = [];
  let score = 0;
  const check = (values: string[] | undefined, actual: string | null | undefined, label: string) => {
    if (!values?.length) return;
    if (actual && values.includes(actual)) {
      score += 4;
      reasons.push(`scoped to ${label} ${actual}`);
    } else {
      // Scoped to a situation that is not this one: actively wrong here.
      score -= 3;
    }
  };
  check(condition.moves, situation.move, "move");
  check(condition.stages, situation.stage, "stage");
  check(condition.temperatures, situation.temperature, "temperature");
  check(condition.booking_states, situation.booking_state, "booking state");
  check(condition.brush_offs, situation.brush_off, "brush-off");
  check(condition.motivations, situation.motivation, "motivation");
  return { score, reasons };
}

/**
 * Ranks coaching examples against the situation the setter is actually in.
 *
 * Tags do most of the work: an example tagged `premature_cta` is about not
 * booking too early, which is worth reading before a value message and worth
 * ignoring in the message that offers the call.
 */
export function rankCoachingExamples(
  examples: CoachingExample[],
  situation: CoachingSituation,
  limit = MAX_COACHING_EXAMPLES,
): { example: CoachingExample; score: number; reasons: string[] }[] {
  const wanted = new Set<string>();
  const reasonFor = new Map<string, string>();

  const want = (tags: CoachingTag[], why: string) => {
    for (const tag of tags) {
      wanted.add(tag);
      if (!reasonFor.has(tag)) reasonFor.set(tag, why);
    }
  };

  if (situation.move) want(MOVE_TAGS[situation.move] ?? [], `the move is ${situation.move}`);
  if (situation.temperature) want(TEMPERATURE_TAGS[situation.temperature] ?? [], `they are ${situation.temperature}`);
  if (situation.service_confusion) want(["service_not_clear"], "they have the wrong idea of what this is");
  if (situation.avoid_money_framing) want(["money_frame_wrong", "wrong_motivation"], "they are not motivated by money");
  if (situation.brush_off && situation.brush_off !== "none") {
    want(["gave_up_too_early", "too_pushy"], `they brushed us off (${situation.brush_off})`);
  }

  return examples
    .map((example) => {
      const scoped = conditionScore(example, situation);
      const reasons = [...scoped.reasons];
      let score = scoped.score;

      for (const tag of example.tags ?? []) {
        if (!wanted.has(tag)) continue;
        score += 2;
        reasons.push(`${tag} — ${reasonFor.get(tag)}`);
      }

      // A whole correction chain teaches more than a single approved line.
      if (example.kind === "correction_chain") score += 1;

      return { example, score, reasons };
    })
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function toItem(example: CoachingExample, reasons: string[]): CoachingItem {
  return {
    kind: example.kind,
    situation: example.situation,
    their_message: example.prospect_message,
    reply: example.approved_reply,
    avoid: example.rejected_reply,
    because: example.operator_feedback,
    why: example.why,
    tags: example.tags ?? [],
    relevance: reasons,
  };
}

/**
 * Assembles the coaching layer for the prompt.
 *
 * Only approved material is included. Pending proposals are deliberately absent:
 * a rule nobody has looked at yet must not change what the setter sends.
 */
export function buildCoachingLayer(input: {
  preferences: SetterPreference[];
  examples: CoachingExample[];
  liveMessages: ApprovedLiveMessage[];
  stage?: string | null;
  /** What the setter is about to do, used to rank the examples. */
  situation?: CoachingSituation;
}): CoachingLayer {
  const stage = input.stage?.toLowerCase() ?? null;
  const situation: CoachingSituation = { stage: input.stage ?? null, ...input.situation };

  // Explicit rules stay global unless the operator scoped them to a stage.
  const rules = input.preferences
    .filter((p) => p.status === "active")
    .filter((p) => !p.applies_to || !stage || p.applies_to.toLowerCase() === stage)
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .map((p) => p.rule);

  const approved = input.examples.filter((e) => e.status === "approved");
  const ranked = rankCoachingExamples(approved, situation);

  // Fall back to the most recent approved examples when nothing is scoped yet —
  // an empty coaching block teaches nothing at all.
  const chosen = ranked.length
    ? ranked.map((r) => toItem(r.example, r.reasons))
    : approved.slice(-MAX_COACHING_EXAMPLES).map((e) => toItem(e, ["no situation-specific coaching yet"]));

  return {
    rules,
    examples: chosen,
    live_messages: input.liveMessages.slice(0, 8),
    precedence: COACHING_PRIORITY.map((t) => TIER_LABELS[t]),
    note: "When two sources conflict, the higher-numbered rule loses. An explicit rule from Cassey beats an example, an example beats a message he once sent, and all of them beat the general instructions.",
    considered: approved.length,
  };
}

// ---------------------------------------------------------------------------
// Learning from live edits
// ---------------------------------------------------------------------------

export type EditObservation = {
  /** What the diff appears to say about how Cassey wants it written. */
  proposed_rule: string;
  /** What kind of change this was, so it can be ranked later. */
  tags: CoachingTag[];
  evidence: { suggested: string; sent: string };
  /** Always false on creation — a person approves it or it never applies. */
  auto_apply: false;
};

const CTA = /\b(call|\d{2} min\w*|jump on|hop on|(chat|speak|talk) (with|to) avo|book (a|in|some)|grab (a |some )?(time|\d{2}))/i;

/** Softening and hardening are the two directions a CTA gets edited in. */
const SOFT_CTA = /\b(no (rush|pressure)|whenever (suits|works)|if (that'?s|it'?s) (useful|of interest)|worth a|happy to|only if)\b/i;
const DIRECT_CTA = /\b(let'?s (do|get|book)|i'?ll send|grab (a |some )?(time|\d{2})|does (mon|tue|wed|thu|fri)\w*|book (you )?in)\b/i;

/** Openings that say nothing. */
const GENERIC_PRAISE = /\b(love (what|your)|amazing (work|stuff)|huge fan|incredible|inspiring|great content|big fan)\b/i;
const FILLER_INTRO = /^\s*(hey|hi|hello)?\s*(there)?[!,. ]*(hope (you'?re|your)|just (reaching out|wanted)|quick one|sorry to bother)/i;

/** Talking about money, revenue and cost. */
const MONEY_FRAME = /\b(revenue|roi|return on|make (you )?more money|profit|sales|monetis|monetiz|leads?)\b/i;

/** Naming a proof point. */
const CREDIBILITY = /\b(clients?|we'?ve (worked|got)|featured|forbes|entrepreneur|published|case study|placements?)\b/i;

/** Saying plainly what this is. */
const SERVICE_CLARITY = /\b(paid|service|we work with clients|isn'?t a (guest|podcast)|not a (guest|podcast)|what we do for clients)\b/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function questions(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

function openingOf(text: string): string {
  return text.trim().split(/[,.—-]/)[0].trim().toLowerCase();
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Content words shared between two strings, as a fraction of the first. */
function overlap(a: string, b: string): number {
  const at = new Set(normalise(a).split(" ").filter((w) => w.length > 3));
  const bt = new Set(normalise(b).split(" ").filter((w) => w.length > 3));
  if (at.size === 0) return 0;
  let shared = 0;
  for (const word of at) if (bt.has(word)) shared += 1;
  return shared / at.size;
}

/** Sentences present in the suggestion and gone from what was actually sent. */
function droppedSentences(suggested: string, sent: string): string[] {
  return sentences(suggested).filter((sentence) => overlap(sentence, sent) < 0.5);
}

/** Sentences the operator wrote that were not in the suggestion. */
function addedSentences(suggested: string, sent: string): string[] {
  return sentences(sent).filter((sentence) => overlap(sentence, suggested) < 0.5);
}

/** Digits and proper nouns are what makes value concrete rather than generic. */
function specificity(text: string): number {
  return (text.match(/\b\d[\d,.%]*\b/g) ?? []).length + (text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).length;
}

/**
 * Reads one edit and proposes what it might mean.
 *
 * Structural changes are unambiguous — a message cut in half, a question
 * removed, a call proposal added — and are read directly. Everything softer is
 * inferred from what was dropped and what was written in its place, and every
 * reading is a proposal: nothing here changes a single suggestion until a person
 * approves it, because a lone edit is evidence of one moment, not of a rule.
 */
export function observeEdit(suggested: string, sent: string): EditObservation[] {
  const out: EditObservation[] = [];
  const evidence = { suggested, sent };
  const propose = (proposed_rule: string, tags: CoachingTag[]) =>
    out.push({ proposed_rule, tags, evidence, auto_apply: false });

  if (!suggested.trim() || !sent.trim() || suggested.trim() === sent.trim()) return out;

  const before = words(suggested);
  const after = words(sent);
  if (before - after >= 15 && after > 0) {
    propose(
      `Cut this shorter: ${before} words was rewritten to ${after}. Aim closer to ${after} words in this situation.`,
      ["too_long"],
    );
  }

  if (questions(suggested) > questions(sent) && questions(sent) === 0) {
    propose(
      "Cassey removed the question entirely — in this situation he makes a statement and lets them come back.",
      ["dead_end_statement"],
    );
  }
  if (questions(sent) > questions(suggested) && questions(suggested) === 0) {
    propose(
      "Cassey turned a statement into a question — this message needed to hand the conversation back rather than end it.",
      ["dead_end_statement"],
    );
  }

  if (CTA.test(suggested) && !CTA.test(sent)) {
    propose("Cassey removed the call proposal — build more value here before suggesting a call.", [
      "premature_cta",
      "weak_value",
    ]);
  }
  if (!CTA.test(suggested) && CTA.test(sent)) {
    propose("Cassey added the call proposal — this situation was ready for it and the draft was too passive.", [
      "cta_too_late",
    ]);
  }
  if (CTA.test(suggested) && CTA.test(sent)) {
    if (!SOFT_CTA.test(suggested) && SOFT_CTA.test(sent)) {
      propose("Cassey softened the call proposal — the ask was harder than the relationship justified.", ["too_pushy"]);
    }
    if (!DIRECT_CTA.test(suggested) && DIRECT_CTA.test(sent)) {
      propose("Cassey made the call proposal more direct — hedging it lost the booking.", ["too_needy"]);
    }
  }

  const dropped = droppedSentences(suggested, sent);
  const added = addedSentences(suggested, sent);

  for (const sentence of dropped) {
    if (GENERIC_PRAISE.test(sentence)) {
      propose(`Cassey cut the compliment — "${sentence.slice(0, 90)}" — it reads as flattery rather than a reason to reply.`, [
        "unnatural_intro",
        "too_needy",
      ]);
    } else if (FILLER_INTRO.test(sentence) && sentence === sentences(suggested)[0]) {
      propose(`Cassey cut the opening line — "${sentence.slice(0, 90)}" — and started with the substance.`, [
        "unnatural_intro",
      ]);
    }
  }

  // Information the prospect had already been given, repeated back at them.
  const repeated = dropped.filter((sentence) => overlap(sentence, suggested.replace(sentence, "")) > 0.6);
  if (repeated.length > 0) {
    propose(`Cassey cut a line that repeated something already said in the same message.`, ["overexplaining"]);
  }
  if (questions(suggested) > 1 && questions(sent) === 1) {
    propose("Cassey cut the message back to a single question — two questions in one DM get neither answered.", [
      "repeated_question",
    ]);
  }

  if (MONEY_FRAME.test(suggested) && !MONEY_FRAME.test(sent)) {
    propose("Cassey took the money framing out — this prospect is not motivated by revenue.", [
      "money_frame_wrong",
      "wrong_motivation",
    ]);
  }
  if (!MONEY_FRAME.test(suggested) && MONEY_FRAME.test(sent)) {
    propose("Cassey put the commercial framing in — this prospect does think in those terms.", ["wrong_motivation"]);
  }

  if (CREDIBILITY.test(suggested) && !CREDIBILITY.test(sent)) {
    propose("Cassey removed the proof point — it was not doing any work here.", ["overexplaining"]);
  }
  if (!CREDIBILITY.test(suggested) && CREDIBILITY.test(sent)) {
    propose("Cassey added a proof point — the value needed something concrete behind it.", ["weak_value"]);
  }

  if (!SERVICE_CLARITY.test(suggested) && SERVICE_CLARITY.test(sent)) {
    propose("Cassey made the service explicit — the draft left what we actually do ambiguous.", ["service_not_clear"]);
  }

  const specificityGain = specificity(sent) - specificity(suggested);
  if (specificityGain >= 2 && added.length > 0) {
    propose(
      `Cassey made the value more specific — added "${added[0].slice(0, 90)}" where the draft was general.`,
      ["weak_value"],
    );
  }

  // Their own words, used back. The clearest signal that a draft sounded generic.
  const mirrored = added.filter((sentence) => /"|'|\bsaid\b/.test(sentence));
  if (mirrored.length > 0) {
    propose("Cassey mirrored the prospect's own wording back to them rather than paraphrasing it.", [
      "human_natural_tone",
    ]);
  }

  const openingBefore = openingOf(suggested);
  const openingAfter = openingOf(sent);
  if (openingBefore && openingAfter && openingBefore !== openingAfter && openingBefore.length <= 40) {
    propose(`Cassey replaced the opening "${openingBefore}" with "${openingAfter}".`, ["unnatural_intro"]);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Importing coaching material from a ChatGPT export
// ---------------------------------------------------------------------------

// The importer lives in `chatgpt-import.ts`: an export is a tree of branches and
// mostly rejected drafts, and reading it correctly is a job in itself.
export { parseChatGptExport, type CoachingCandidate } from "@/core/chatgpt-import";
