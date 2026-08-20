import { QUALIFICATION_DIMENSIONS } from "@/core/gate";
import type { DialogueState } from "@/core/dialogue-state";
import type { UnderstandingAssessment } from "@/core/understanding";
import type { Lead, LeadMemory, Message, Qualification } from "@/lib/types";

/**
 * Evidence behind every qualification dimension.
 *
 * Scores on their own are unfalsifiable: a strategist that says
 * `media_gap: 2` with nothing to point at has guessed, and the gate then lets a
 * guess book a call. Each dimension is therefore reconstructed from what is
 * actually in the thread, the lead profile and long-term memory, and the model's
 * own score is capped by what that evidence can support.
 *
 * The model is still allowed to see something the patterns miss — but only if it
 * quotes the conversation, and only for one point. The quote is verified
 * verbatim against the real messages, so an invented one earns nothing.
 */

export type EvidenceSource = "prospect" | "setter" | "profile" | "memory";

export type EvidenceQuote = {
  quote: string;
  message_id: string | null;
  source: EvidenceSource;
};

export type DimensionEvidence = {
  dimension: keyof Qualification;
  /** What the evidence alone supports, 0–2. */
  evidenced: 0 | 1 | 2;
  quotes: EvidenceQuote[];
  reason: string;
};

export type QualificationEvidence = Record<keyof Qualification, DimensionEvidence>;

/** A dimension score the model claimed, with the quote it says supports it. */
export type ClaimedEvidence = { dimension: string; quote: string; message_id?: string | null };

const MEDIA_GAP_ADMISSION = [
  /\b(not much|nothing|barely anything|hardly anything|not a lot)\b/i,
  /\b(don'?t|do not) (really )?have (any|much)\b/i,
  /\bno (press|coverage|articles|media)\b/i,
  /\bjust (my|our) (site|website|instagram|linkedin|socials?)\b/i,
  /\b(never|haven'?t) (done|had) (any )?(press|media|interviews?)\b/i,
  /\bnothing (comes up|really comes up|written)\b/i,
];

/** The mechanism, in the words we would use to explain it. */
const MECHANISM_WORDS = [
  "credibility",
  "authority",
  "search",
  "seo",
  "syndication",
  "syndicated",
  "written media",
  "positioning",
  "diligence",
  "third-party",
  "third party",
  "press",
  "coverage",
  "podcast",
  "publication",
];

const INTEREST_SIGNALS = [
  /\b(i'?m|im) (interested|keen|in)\b/i,
  /\btell me more\b/i,
  /\bwhat did you have in mind\b/i,
  /\b(sounds|that sounds) (good|great|interesting)\b/i,
  /\b(happy|down|keen|open) to (hear|chat|talk|jump on|learn)\b/i,
  /\bhear it out\b/i,
  /\bhow much|what do you charge|pricing\b/i,
  /\bhow (do we|would we|does that) (start|work|go)\b/i,
  /\bsend (me )?(the|a) (link|details|invite)\b/i,
];

function textOf(m: Pick<Message, "message_text">): string {
  return (m.message_text ?? "").replace(/\s+/g, " ").trim();
}

function firstMatching(
  messages: Message[],
  patterns: RegExp[],
  source: EvidenceSource,
): EvidenceQuote | null {
  for (const m of messages) {
    const text = textOf(m);
    if (!text) continue;
    if (patterns.some((re) => re.test(text))) {
      return { quote: text.slice(0, 200), message_id: m.id ?? null, source };
    }
  }
  return null;
}

function fromProfile(value: string | null | undefined, label: string): EvidenceQuote | null {
  const v = (value ?? "").trim();
  return v ? { quote: `${label}: ${v}`, message_id: null, source: "profile" } : null;
}

function fromMemory(items: LeadMemory[keyof LeadMemory] | undefined, label: string): EvidenceQuote | null {
  const list = Array.isArray(items) ? items : [];
  const first = list[0] as { value?: string; quote?: string | null; source_message_id?: string | null } | undefined;
  if (!first?.value) return null;
  return {
    quote: `${label}: ${first.quote ?? first.value}`,
    message_id: first.source_message_id ?? null,
    source: "memory",
  };
}

function level(quotes: (EvidenceQuote | null)[]): { evidenced: 0 | 1 | 2; quotes: EvidenceQuote[] } {
  const kept = quotes.filter((q): q is EvidenceQuote => q !== null);
  const evidenced = kept.length >= 2 ? 2 : kept.length === 1 ? 1 : 0;
  return { evidenced, quotes: kept };
}

export type EvidenceInput = {
  lead: Lead;
  memory: LeadMemory | null;
  messages: Message[];
  dialogue: DialogueState;
  understanding: UnderstandingAssessment;
};

/**
 * Rebuilds every dimension from evidence.
 *
 * A dimension scores 2 only when two independent things support it — the
 * prospect's own words plus a profile or memory record, say. One source is worth
 * one point. Nothing is worth nothing, and nothing is exactly what the gate then
 * refuses to let through.
 */
export function assessQualificationEvidence(input: EvidenceInput): QualificationEvidence {
  const { lead, memory, messages, dialogue, understanding } = input;
  const prospect = messages.filter((m) => m.sender === "prospect");
  const setter = messages.filter((m) => m.sender === "setter");

  // fit — who they are, from the profile and from what they have told us.
  const fitQuotes = level([
    fromProfile(lead.industry, "industry") ?? fromProfile(lead.niche, "niche"),
    fromProfile(lead.company, "company") ?? fromProfile(lead.job_title, "role"),
    dialogue.topics.commercial_goal.answered
      ? {
          quote: dialogue.topics.commercial_goal.answer_quote ?? "",
          message_id: dialogue.topics.commercial_goal.answer_message_id,
          source: "prospect" as const,
        }
      : null,
  ]);

  // commercial_goal — what they are working toward, in their words where possible.
  const goalFromThread = dialogue.topics.commercial_goal.answered
    ? {
        quote: dialogue.topics.commercial_goal.answer_quote ?? "",
        message_id: dialogue.topics.commercial_goal.answer_message_id,
        source: "prospect" as const,
      }
    : null;
  const goal = level([goalFromThread, fromMemory(memory?.goals, "goal") ?? fromProfile(lead.commercial_goal, "goal")]);

  // media_gap — they must acknowledge it; a profile note alone is our assumption.
  const gapAdmission = firstMatching(prospect, MEDIA_GAP_ADMISSION, "prospect");
  const gap = level([
    gapAdmission,
    fromMemory(memory?.pain_points, "pain point") ?? fromProfile(lead.media_gap, "media gap"),
  ]);

  // value_established — WE must have connected the mechanism to THEIR goal, and
  // it only counts as landed once they engage with it.
  const valueMessage = setter.find((m) => {
    const t = textOf(m).toLowerCase();
    return MECHANISM_WORDS.filter((w) => t.includes(w)).length >= 2;
  });
  const valueEngagement = understanding.evidence.find((e) => e.strength !== "weak");
  const value = level([
    valueMessage ? { quote: textOf(valueMessage).slice(0, 200), message_id: valueMessage.id ?? null, source: "setter" } : null,
    valueEngagement
      ? { quote: valueEngagement.quote, message_id: valueEngagement.message_id, source: "prospect" }
      : null,
  ]);

  // service_understanding — already evidenced strictly from their own words.
  const understandingQuotes: EvidenceQuote[] = understanding.evidence
    .filter((e) => e.strength !== "weak")
    .map((e) => ({ quote: e.quote, message_id: e.message_id, source: "prospect" as const }));

  // interest_signal — they must have shown they want this.
  const interestQuote = firstMatching(prospect, INTEREST_SIGNALS, "prospect");
  const interest = level([
    interestQuote,
    dialogue.topics.openness_interest.answered
      ? {
          quote: dialogue.topics.openness_interest.answer_quote ?? "",
          message_id: dialogue.topics.openness_interest.answer_message_id,
          source: "prospect" as const,
        }
      : null,
    fromMemory(memory?.buying_signals, "buying signal"),
  ]);

  return {
    fit: {
      dimension: "fit",
      ...fitQuotes,
      reason: fitQuotes.evidenced === 0 ? "Nothing known about who this person is yet." : "Established from the profile and what they have said.",
    },
    commercial_goal: {
      dimension: "commercial_goal",
      ...goal,
      reason:
        goal.evidenced === 0
          ? "They have not said what they are building toward."
          : goalFromThread
            ? "They stated a goal in their own words."
            : "Recorded, but not yet confirmed in their own words.",
    },
    media_gap: {
      dimension: "media_gap",
      ...gap,
      reason:
        gap.evidenced === 0
          ? "No gap has been surfaced — nothing to solve yet."
          : gapAdmission
            ? "They acknowledged the gap themselves."
            : "We believe there is a gap, but they have not acknowledged it.",
    },
    value_established: {
      dimension: "value_established",
      ...value,
      reason:
        value.evidenced === 0
          ? "We have not tied the mechanism to their goal."
          : valueEngagement
            ? "We made the argument and they engaged with it."
            : "We made the argument; they have not responded to it yet.",
    },
    service_understanding: {
      dimension: "service_understanding",
      evidenced: understanding.level,
      quotes: understandingQuotes,
      reason:
        understanding.confusion?.reason ??
        (understanding.level === 0
          ? "Nothing in their own words shows they understand what this is."
          : "Evidenced from their own words."),
    },
    interest_signal: {
      dimension: "interest_signal",
      ...interest,
      reason: interest.evidenced === 0 ? "They have not shown they want this." : "They signalled interest themselves.",
    },
  };
}

function normalise(s: string): string {
  // Apostrophes are dropped rather than turned into spaces, so "I'm" and "im"
  // are the same word — the model rarely reproduces punctuation exactly.
  return s
    .toLowerCase()
    .replace(/['\u2018\u2019\u02bc]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verifies a quote the model attributed to the conversation.
 *
 * Substring match on normalised text, so punctuation and casing do not matter
 * but invention does: a quote that is not in the thread is not evidence.
 */
export function verifyQuote(quote: string, messages: Message[]): { found: boolean; message_id: string | null } {
  const needle = normalise(quote);
  if (needle.length < 12) return { found: false, message_id: null };
  for (const m of messages) {
    if (normalise(textOf(m)).includes(needle)) return { found: true, message_id: m.id ?? null };
  }
  return { found: false, message_id: null };
}

export type ReconciledQualification = {
  qualification: Qualification;
  /** Human-readable record of every score the evidence would not support. */
  adjustments: string[];
  evidence: QualificationEvidence;
};

/**
 * Caps the model's qualification at what the evidence supports.
 *
 * A verified quote buys exactly one point of benefit of the doubt on the
 * dimensions inferred from language. `service_understanding` gets none: it is
 * the dimension most often talked up, and it is already assessed strictly from
 * the prospect's own words.
 */
export function reconcileQualification(
  claimed: Qualification,
  evidence: QualificationEvidence,
  claimedEvidence: ClaimedEvidence[],
  messages: Message[],
): ReconciledQualification {
  const qualification = { ...claimed };
  const adjustments: string[] = [];

  for (const dimension of QUALIFICATION_DIMENSIONS) {
    const dim = evidence[dimension];
    const claim = claimedEvidence.find((c) => c.dimension === dimension);
    const verified = claim ? verifyQuote(claim.quote, messages) : { found: false, message_id: null };

    const allowance = dimension === "service_understanding" ? 0 : verified.found ? 1 : 0;
    const ceiling = Math.min(2, dim.evidenced + allowance);
    const proposed = qualification[dimension] ?? 0;

    if (proposed > ceiling) {
      qualification[dimension] = ceiling;
      adjustments.push(
        `${dimension}: ${proposed} → ${ceiling}. ${dim.reason}${
          claim && !verified.found ? " The supporting quote was not found in the conversation." : ""
        }`,
      );
    }

    if (verified.found && claim) {
      dim.quotes = [...dim.quotes, { quote: claim.quote, message_id: verified.message_id, source: "prospect" }];
    }
  }

  return { qualification, adjustments, evidence };
}
