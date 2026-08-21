import {
  proposeSlots,
  type BookingAssessment,
  type BookingState,
  type CallSlot,
  type NoShowAssessment,
  type SlotProposal,
} from "@/core/booking";
import { TOPIC_LABELS, nextBestTopic, type DialogueState, type Topic } from "@/core/dialogue-state";
import { countQuestions } from "@/core/style";
import type { BrushOffAssessment } from "@/core/brush-off";
import type { TemperatureAssessment } from "@/core/temperature";
import type { UnderstandingAssessment } from "@/core/understanding";
import type { GateResult } from "@/lib/types";

/**
 * What this one message is for, and what happens after they reply.
 *
 * A setter that writes a message without knowing what it is supposed to achieve
 * produces statements — the operator's other standing complaint ("this is a
 * statement", "then where will this lead?"). Every DM makes exactly one move,
 * has a response it is trying to provoke, and has a defined next step for a
 * positive reply, a negative reply and silence.
 */

export const MOVES = [
  "cold_opener",
  "respect_rejection",
  "correct_premise",
  "clarify_commercial",
  "clarify_after_brushoff",
  "park_and_agree_time",
  "ask_discovery",
  "build_value",
  "test_interest",
  "offer_call",
  "arrange_logistics",
  "hold",
] as const;
export type Move = (typeof MOVES)[number];

export type MessagePlan = {
  move: Move;
  /** What this message is for, in one line. */
  purpose: string;
  /** The reply we are trying to provoke. */
  desired_response: string;
  next_if_positive: string;
  next_if_negative: string;
  next_if_no_reply: string;
  /** Moves that would be wrong right now, and why. */
  forbidden: { move: Move; why: string }[];
  /** The single topic to ask about, when the move is a question. */
  ask_topic: Topic | null;
  /**
   * Concrete times to put in this message. Only populated when the move is to
   * book: proposing the call and offering the times is one move, not two.
   */
  slots: CallSlot[];
  /** How to talk about time given what we know of their timezone. */
  timezone_note: string | null;
  /**
   * How to adapt the booking for no-show risk. Advice about framing, commitment
   * and logistics — never about whether a qualified prospect may be offered a
   * call.
   */
  risk_adaptation: string | null;
  /** How far into booking the conversation already is. */
  booking_state: BookingState;
};

const CALL_FORBIDDEN = {
  move: "offer_call" as Move,
  why: "The call gate has not been met — a call proposed now is a call that no-shows.",
};

/**
 * Chooses the one move this message should make.
 *
 * Ordered by what overrides what: an explicit rejection outranks everything, a
 * wrong premise outranks discovery, and discovery outranks a call. The model is
 * given this plan rather than asked to invent one.
 */
export function planMessage(input: {
  dialogue: DialogueState;
  understanding: UnderstandingAssessment;
  brushOff: BrushOffAssessment;
  temperature: TemperatureAssessment;
  gate: GateResult;
  clarificationSpent: boolean;
  booking: BookingAssessment;
  noShow: NoShowAssessment;
  /** Research facts a person has verified, usable in a cold opener. */
  verifiedResearch?: { value: string }[];
  /** Concrete times to offer once the gate is open. */
  slotProposal?: SlotProposal;
}): MessagePlan {
  const { dialogue, understanding, brushOff, temperature, gate, clarificationSpent, booking, noShow } = input;

  const base = {
    forbidden: [] as { move: Move; why: string }[],
    ask_topic: null as Topic | null,
    slots: [] as CallSlot[],
    timezone_note: null as string | null,
    risk_adaptation: null as string | null,
    booking_state: booking.state,
  };

  // Nothing has been said back yet: this is an opener, not a conversation.
  if (dialogue.prospect_message_count === 0) {
    const fact = input.verifiedResearch?.[0]?.value ?? null;
    return {
      ...base,
      move: "cold_opener",
      purpose: fact
        ? `Open on one specific thing we can actually see: ${fact}.`
        : "Open with something specific and easy to answer. We have no verified research, so do not imply we know anything about them.",
      desired_response: "A reply of any length. The only job of an opener is to start a conversation.",
      next_if_positive: "Ask what they are building toward before anything else.",
      next_if_negative: "Accept it in one line and stop.",
      next_if_no_reply: "One short follow-up from a different angle, then leave it.",
      forbidden: [
        CALL_FORBIDDEN,
        { move: "build_value", why: "Nothing is known about their goal yet — a pitch into silence is a cold pitch." },
        { move: "clarify_commercial", why: "Explaining the service before they have said a word is a brochure, not a DM." },
      ],
    };
  }

  if (brushOff.should_disengage) {
    return {
      ...base,
      move: "respect_rejection",
      purpose: "Acknowledge the no, leave the door open, and stop selling.",
      desired_response: "None. A reply is not the objective.",
      next_if_positive: "If they re-engage later, resume from what they already told us.",
      next_if_negative: "Close the thread. Do not follow up.",
      next_if_no_reply: "Close the thread. Do not follow up.",
      forbidden: [
        CALL_FORBIDDEN,
        { move: "build_value", why: "They have declined with full understanding. More value is pressure." },
        { move: "ask_discovery", why: "Discovery after a no is not curiosity, it is persistence." },
      ],
    };
  }

  if (brushOff.kind === "timing_objection") {
    return {
      ...base,
      move: "park_and_agree_time",
      purpose: "Accept the timing, agree a specific point to pick it back up, and stop selling.",
      desired_response: "Agreement to a concrete month or milestone.",
      next_if_positive: "Record the date as a follow-up commitment and go quiet until then.",
      next_if_negative: "Accept it and close the thread warmly.",
      next_if_no_reply: "Follow up once at the timeframe they named, not before.",
      forbidden: [CALL_FORBIDDEN, { move: "build_value", why: "They deferred on timing, not on value." }],
    };
  }

  if (understanding.confusion) {
    return {
      ...base,
      move: "correct_premise",
      purpose: `Correct what they think this is: ${understanding.confusion.reason}.`,
      desired_response: "A reply that engages with the actual service rather than the guest invitation they imagined.",
      next_if_positive: "Re-anchor on their goal and resume discovery from where it stopped.",
      next_if_negative: "If they only wanted a free guest spot, thank them and close.",
      next_if_no_reply: "One short follow-up that restates what this is, then stop.",
      forbidden: [
        CALL_FORBIDDEN,
        { move: "build_value", why: "Value built on a wrong premise reinforces the wrong premise." },
      ],
    };
  }

  if (understanding.commercial_clarity_needed) {
    return {
      ...base,
      move: "clarify_commercial",
      purpose: "Make plain that this is a paid service, without correcting a premise they never held.",
      desired_response: "An answer that shows they have taken the commercial model on board.",
      next_if_positive: "Continue building value toward their goal.",
      next_if_negative: "If budget is genuinely the issue, close it out honestly rather than discounting.",
      next_if_no_reply: "Leave it. Ambiguity about money is best resolved in one clear message, not three.",
      forbidden: [CALL_FORBIDDEN],
    };
  }

  if (brushOff.kind === "uninformed_brushoff" && !clarificationSpent) {
    return {
      ...base,
      move: "clarify_after_brushoff",
      purpose: "They declined something they were never told. Say what this actually is, once, without pressure.",
      desired_response: "Either genuine interest now they know, or a clear no we can respect.",
      next_if_positive: "Resume discovery from their goal.",
      next_if_negative: "Respect it and stop.",
      next_if_no_reply: "Stop. The allowance is spent.",
      forbidden: [
        CALL_FORBIDDEN,
        { move: "ask_discovery", why: "They just declined. A question now reads as ignoring them." },
      ],
    };
  }

  // Past the gate, the booking substate decides the move: a conversation that
  // has already had slots offered must not be sent another pitch for a call.
  if (booking.state !== "not_ready" && booking.state !== "call_ready") {
    return {
      ...base,
      move: "arrange_logistics",
      purpose: booking.next_action,
      desired_response:
        booking.state === "slot_selected" || booking.state === "email_needed"
          ? "Their email address."
          : booking.state === "slots_offered"
            ? "A specific day and time."
            : "Confirmation that it is in their calendar.",
      next_if_positive:
        booking.state === "invite_pending" || booking.state === "booked"
          ? "Nothing further. It is Avo's conversation now."
          : "Move straight to the next missing detail — do not re-sell.",
      next_if_negative: "Offer one alternative. If that fails, agree to revisit rather than chase.",
      next_if_no_reply: "One short nudge restating the specific time, then leave it.",
      risk_adaptation: noShow.risk === "low" ? null : `No-show risk is ${noShow.risk}: ${noShow.guidance.logistics} ${noShow.guidance.followup}`,
      forbidden: [
        { move: "build_value", why: "The value is accepted — more of it now reads as doubt." },
        { move: "ask_discovery", why: "Discovery after a slot is agreed only reopens the decision." },
      ],
    };
  }

  if (gate.passed) {
    // Qualification is the only gate. No-show risk changes HOW the call is
    // offered — the framing, the commitment asked for, the logistics — and never
    // whether a qualified prospect is allowed to be offered one.
    const proposal = input.slotProposal ?? proposeSlots();
    return {
      ...base,
      move: "offer_call",
      purpose:
        "Every dimension is established. Contextualise the call in one line, propose it with Avo, and offer two concrete times in this same message.",
      desired_response: "One of the two times, or a specific objection we can handle.",
      next_if_positive: "Take the time they picked and ask for the email to send the invite to. Nothing else.",
      next_if_negative: "Handle the objection; do not re-pitch the value they already accepted.",
      next_if_no_reply: "One short nudge that restates the two times, then leave it.",
      slots: proposal.slots,
      timezone_note: proposal.timezone_note,
      risk_adaptation:
        noShow.risk === "low"
          ? null
          : `No-show risk is ${noShow.risk}: ${noShow.guidance.frame_purpose} ${noShow.guidance.logistics} ${noShow.guidance.commitment}`,
      forbidden: [
        { move: "ask_discovery", why: "Qualification is met. Another question here delays a call they are ready for." },
      ],
    };
  }

  // Below the gate: decide between asking, building and testing.
  const topic = nextBestTopic(dialogue);
  const missing = gate.missing_dimensions;

  if (missing.includes("value_established") && !missing.includes("commercial_goal") && !missing.includes("media_gap")) {
    return {
      ...base,
      move: "build_value",
      purpose: "Connect what we do to the goal and gap they have already given us.",
      desired_response: "A reaction to the argument — agreement, a question, or a challenge.",
      next_if_positive: "Test whether they want this, then move toward a call.",
      next_if_negative: "Find out which part did not land rather than repeating it.",
      next_if_no_reply: "One short message from a different angle on the same goal, then stop.",
      forbidden: [CALL_FORBIDDEN, { move: "ask_discovery", why: "They have told us enough; more questions stall it." }],
    };
  }

  if (missing.includes("interest_signal") && !missing.includes("value_established")) {
    return {
      ...base,
      move: "test_interest",
      purpose: "Find out whether they actually want this before proposing anything.",
      desired_response: "A clear signal either way.",
      next_if_positive: "Move toward the call.",
      next_if_negative: "Accept it and close warmly.",
      next_if_no_reply: "Leave it. Proposing a call into silence is how leads are burned.",
      forbidden: [CALL_FORBIDDEN],
    };
  }

  if (topic) {
    return {
      ...base,
      move: "ask_discovery",
      ask_topic: topic,
      purpose: `Establish: ${TOPIC_LABELS[topic]}.`,
      desired_response: "A specific answer in their own words.",
      next_if_positive: "Use their answer to build value against it, then test interest.",
      next_if_negative: "If they deflect, build a little value first and earn the answer.",
      next_if_no_reply: "One short, lighter message. Do not re-ask the same question.",
      forbidden: [
        CALL_FORBIDDEN,
        ...(temperature.temperature === "guarded"
          ? [{ move: "build_value" as Move, why: "They are guarded — a pitch now ends the conversation." }]
          : []),
      ],
    };
  }

  return {
    ...base,
    move: "build_value",
    purpose: "Everything has been asked. Make the value specific to what they told us.",
    desired_response: "A reaction we can qualify on.",
    next_if_positive: "Test interest, then propose the call.",
    next_if_negative: "Understand the objection before answering it.",
    next_if_no_reply: "One short message from a new angle, then stop.",
    forbidden: [CALL_FORBIDDEN],
  };
}

const CTA_PATTERNS = [
  /\b(jump|hop|get) on a (quick )?call\b/i,
  /\b(grab|book|set up|schedule) (a |some )?(time|call|chat|20 min)/i,
  /\bwould you be free\b/i,
  /\bwhat (day|time) works\b/i,
  /\bthis week or next\b/i,
  /\b(20|15|30) min(ute)?s? (with|chat|call)\b/i,
  /\bspeak to avo\b/i,
  /\bcall with avo\b/i,
];

export type MoveAudit = {
  questions: number;
  has_cta: boolean;
  violations: string[];
};

const DAY_NAME = /\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/gi;
const CLOCK_TIME = /\b\d{1,2}([:.]\d{2})?\s?(am|pm)?\s?[–-]\s?\d{1,2}([:.]\d{2})?\s?(am|pm)?\b|\b\d{1,2}([:.]\d{2})\b|\b\d{1,2}\s?(am|pm)\b/gi;

/**
 * Counts how many genuinely concrete time options a draft puts on the table.
 *
 * "this week or next" is not an option, it is a diary invitation: the prospect
 * has to do the work of proposing something, and that is the turn that gets
 * lost. Distinct named days and distinct clock times both count.
 */
export function countConcreteTimeOptions(draft: string): number {
  const days = new Set((draft.match(DAY_NAME) ?? []).map((d) => d.toLowerCase().slice(0, 3)));
  if (days.size >= 2) return days.size;
  const times = new Set((draft.match(CLOCK_TIME) ?? []).map((t) => t.toLowerCase().replace(/\s+/g, "")));
  return Math.max(days.size, times.size >= 2 ? times.size : days.size + (times.size > 0 ? 1 : 0));
}

/**
 * Checks the draft makes exactly one move.
 *
 * A question plus a CTA is two moves: it asks them to think and to commit in the
 * same breath, and reliably gets neither.
 */
export function auditMoves(draft: string, plan: MessagePlan): MoveAudit {
  const questions = countQuestions(draft);
  const has_cta = CTA_PATTERNS.some((re) => re.test(draft));
  const violations: string[] = [];

  if (questions > 1) violations.push(`Two or more questions in one DM (${questions}). Make one move.`);
  if (has_cta && questions > 0 && plan.move !== "offer_call" && plan.move !== "arrange_logistics") {
    violations.push("Asks a discovery question and proposes a call in the same message. That is two moves.");
  }
  if (has_cta && plan.forbidden.some((f) => f.move === "offer_call")) {
    violations.push(`Proposes a call, which is forbidden right now: ${plan.forbidden.find((f) => f.move === "offer_call")?.why}`);
  }
  if (plan.move === "ask_discovery" && questions === 0) {
    violations.push("The plan is to ask a question, but the draft asks nothing — it is a statement.");
  }
  if (plan.move === "cold_opener" && /\b(i (researched|looked (you|into))|been following you|read all about)\b/i.test(draft)) {
    violations.push("Sounds like we researched them. Mention what we noticed, not the researching.");
  }
  if (plan.move === "offer_call" && plan.slots.length >= 2 && countConcreteTimeOptions(draft) < 2) {
    violations.push(
      `Proposes the call without two concrete times. Offer them in this message (${plan.slots
        .map((s) => s.label)
        .join(" / ")}) instead of asking what suits — the extra turn is where bookings are lost.`,
    );
  }
  // A call already agreed must not be proposed a second time: it reads as though
  // we were not listening, and reopens a decision they have already made.
  const AGREED: BookingState[] = ["slot_selected", "email_needed", "invite_pending", "booked"];
  if (plan.move === "arrange_logistics" && AGREED.includes(plan.booking_state) && has_cta) {
    violations.push(
      `A time is already agreed (${plan.booking_state.replace(/_/g, " ")}). Proposing the call again reopens a settled decision — ask only for what is still missing.`,
    );
  }
  if (plan.move === "respect_rejection" && questions > 0) {
    violations.push("They have declined. A question here is persistence, not curiosity.");
  }

  return { questions, has_cta, violations };
}
