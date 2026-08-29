import { assessBooking } from "@/core/booking";
import { buildDialogueState } from "@/core/dialogue-state";
import { classifyBrushOff } from "@/core/brush-off";
import { assessUnderstanding } from "@/core/understanding";
import { evaluateGate, totalScore } from "@/core/gate";
import { assessQualificationEvidence } from "@/core/qualification-evidence";
import type { Lead, LeadMemory, Message, Qualification } from "@/lib/types";

/**
 * The outbound funnel, per account.
 *
 * Every stage here is derived from what is actually recorded — messages, the
 * booking sequence, the qualification evidence, the lead's outcome — rather than
 * from a counter someone remembered to increment. That means the numbers can be
 * recomputed from the data at any time, and a stage cannot silently drift out of
 * step with the conversation it describes.
 *
 * Comparing accounts is the point: two pages sending the same volume with very
 * different reply rates is the signal worth acting on.
 */

export const FUNNEL_STAGES = [
  "dms_sent",
  "conversations",
  "replies",
  "positive_replies",
  "qualified",
  "calls_offered",
  "calls_booked",
  "shows",
  "no_shows",
  "onboardings",
  "not_interested",
] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export type FunnelCounts = Record<FunnelStage, number>;

export type AccountFunnel = {
  account_id: string | null;
  account_handle: string | null;
  account_name: string | null;
  active: boolean;
  counts: FunnelCounts;
  /** Stage-to-stage conversion, null where the denominator is zero. */
  rates: {
    reply_rate: number | null;
    positive_reply_rate: number | null;
    qualification_rate: number | null;
    offer_rate: number | null;
    booking_rate: number | null;
    show_rate: number | null;
    onboarding_rate: number | null;
  };
};

/** Outcomes recorded on the lead, however they were spelled. */
const OUTCOME_PATTERNS: { re: RegExp; stage: FunnelStage }[] = [
  { re: /\b(onboard\w*|closed|client|won)\b/i, stage: "onboardings" },
  { re: /\bno[ _-]?show\b/i, stage: "no_shows" },
  { re: /\b(not[ _-]?interested|lost|declined|rejected)\b/i, stage: "not_interested" },
  { re: /\b(showed|attended|discovery[ _-]?(done|held)|call[ _-]?held)\b/i, stage: "shows" },
];

function outcomeStage(outcome: string | null | undefined): FunnelStage | null {
  const text = (outcome ?? "").trim();
  if (!text) return null;
  for (const { re, stage } of OUTCOME_PATTERNS) {
    if (re.test(text)) return stage;
  }
  return null;
}

/** A reply that is engagement rather than a brush-off. */
const POSITIVE_REPLY = [
  /\b(interested|keen|sounds (good|interesting|useful)|tell me more|hear more|open to|down to|how much|what do you charge|makes sense|i'?d like)\b/i,
  /\b(yes|yeah|sure)\b.{0,20}\b(please|i would|that works|go on)\b/i,
];

export type LeadFunnelInput = {
  lead: Lead;
  messages: Message[];
  memory: LeadMemory | null;
};

export type LeadFunnel = {
  lead_id: string;
  account_id: string | null;
  stages: Partial<Record<FunnelStage, number>>;
  /** Why each terminal stage was counted, so a number can be traced back. */
  reasons: string[];
};

/**
 * Places one conversation in the funnel.
 *
 * Stages are cumulative where that is the truth of the thing — a booked call was
 * also offered, and an onboarding also showed — because otherwise a conversion
 * rate between two stages is measured against a denominator that has leaked.
 */
export function leadFunnel(input: LeadFunnelInput): LeadFunnel {
  const { lead, messages, memory } = input;
  const stages: Partial<Record<FunnelStage, number>> = {};
  const reasons: string[] = [];

  const setterMessages = messages.filter((m) => m.sender === "setter");
  const prospectMessages = messages.filter((m) => m.sender === "prospect");

  stages.dms_sent = setterMessages.length;
  if (setterMessages.length > 0) stages.conversations = 1;

  if (prospectMessages.length > 0) {
    stages.replies = 1;

    const understanding = assessUnderstanding(prospectMessages, Boolean(memory?.service_explained));
    const latest = prospectMessages[prospectMessages.length - 1];
    const brushOff = classifyBrushOff(latest, {
      understandsService: understanding.level >= 2,
      serviceExplained: Boolean(memory?.service_explained),
    });

    const engaged = prospectMessages.some((m) => POSITIVE_REPLY.some((re) => re.test(m.message_text ?? "")));
    // A decline is not a positive reply, however politely it is worded.
    if (engaged && !brushOff.should_disengage) {
      stages.positive_replies = 1;
      reasons.push("Replied with interest rather than a decline.");
    }

    const dialogue = buildDialogueState(messages, memory);
    const evidence = assessQualificationEvidence({ lead, memory, messages, dialogue, understanding });
    const qualification: Qualification = {
      fit: evidence.fit.evidenced,
      commercial_goal: evidence.commercial_goal.evidenced,
      media_gap: evidence.media_gap.evidenced,
      value_established: evidence.value_established.evidenced,
      service_understanding: understanding.level,
      interest_signal: evidence.interest_signal.evidenced,
    };
    const gate = evaluateGate({
      qualification,
      total_score: totalScore(qualification),
      service_confusion: understanding.confusion !== null,
      call_ready: false,
      // The rest of a Strategy is the model's narrative; the gate reads none of it.
      stage: lead.conversation_stage ?? "UNKNOWN",
      confusion_reason: understanding.confusion?.reason ?? null,
      next_objective: "",
      strategy: "",
      missing_information: [],
      credibility_needed: false,
      credibility_reason: null,
      should_explain_service: false,
      evidence: [],
    });
    if (gate.passed) {
      stages.qualified = 1;
      reasons.push("Every qualification dimension is evidenced.");
    }

    const booking = assessBooking(messages, gate.passed);
    if (booking.state !== "not_ready" && booking.state !== "call_ready") {
      stages.calls_offered = 1;
      reasons.push(`A call reached the "${booking.state.replace(/_/g, " ")}" stage.`);
    }
    if (["slot_selected", "email_needed", "invite_pending", "booked"].includes(booking.state)) {
      stages.calls_booked = 1;
      reasons.push("A time was agreed.");
    }
  }

  // The lead record is the authority on what happened after the DMs stopped.
  if (lead.booked_call) {
    stages.calls_offered = 1;
    stages.calls_booked = 1;
    reasons.push("Recorded on the lead as a booked call.");
  }

  const outcome = outcomeStage(lead.outcome);
  if (outcome) {
    stages[outcome] = 1;
    reasons.push(`Recorded outcome: ${lead.outcome}.`);
    // An onboarding implies the call happened; a no-show implies it did not.
    if (outcome === "onboardings") {
      stages.shows = 1;
      stages.calls_booked = 1;
      stages.calls_offered = 1;
    }
    if (outcome === "no_shows") {
      stages.calls_booked = 1;
      stages.calls_offered = 1;
    }
  }

  return { lead_id: lead.id, account_id: lead.outbound_account_id, stages, reasons };
}

function emptyCounts(): FunnelCounts {
  return Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0])) as FunnelCounts;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Number((numerator / denominator).toFixed(3));
}

/**
 * Rolls per-lead funnels up by outbound account.
 *
 * Leads with no account are reported under a null account rather than dropped or
 * folded into another one: an unattributed conversation is a fact about the data
 * and should be visible, not hidden inside somebody else's numbers.
 */
export function funnelByAccount(
  leads: LeadFunnel[],
  accounts: { id: string; handle: string; display_name: string | null; active: boolean }[],
): AccountFunnel[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const buckets = new Map<string, FunnelCounts>();

  for (const lead of leads) {
    const key = lead.account_id ?? "";
    const counts = buckets.get(key) ?? emptyCounts();
    for (const stage of FUNNEL_STAGES) counts[stage] += lead.stages[stage] ?? 0;
    buckets.set(key, counts);
  }

  // Accounts with no leads still appear, at zero: an account that has sent
  // nothing is a thing worth seeing.
  for (const account of accounts) {
    if (!buckets.has(account.id)) buckets.set(account.id, emptyCounts());
  }

  return [...buckets.entries()]
    .map(([id, counts]) => {
      const account = id ? byId.get(id) ?? null : null;
      return {
        account_id: id || null,
        account_handle: account?.handle ?? null,
        account_name: account?.display_name ?? null,
        active: account?.active ?? false,
        counts,
        rates: {
          reply_rate: rate(counts.replies, counts.conversations),
          positive_reply_rate: rate(counts.positive_replies, counts.replies),
          qualification_rate: rate(counts.qualified, counts.replies),
          offer_rate: rate(counts.calls_offered, counts.qualified),
          booking_rate: rate(counts.calls_booked, counts.calls_offered),
          show_rate: rate(counts.shows, counts.calls_booked),
          onboarding_rate: rate(counts.onboardings, counts.calls_booked),
        },
      };
    })
    .sort((a, b) => b.counts.dms_sent - a.counts.dms_sent);
}
