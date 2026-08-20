import type { DialogueState } from "@/core/dialogue-state";
import type { Message, Qualification } from "@/lib/types";

/**
 * Booking is not one step.
 *
 * "Call ready" and "call booked" were the only two states, so a conversation
 * that had offered slots, had a slot picked and was waiting on an email address
 * all looked identical to the setter — and it kept re-offering the call. The
 * real sequence has six states, each with exactly one thing left to get.
 */

export const BOOKING_STATES = [
  "not_ready",
  "call_ready",
  "slots_offered",
  "slot_selected",
  "email_needed",
  "invite_pending",
  "booked",
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export type BookingAssessment = {
  state: BookingState;
  /** The one thing this state needs next. */
  next_action: string;
  evidence: { quote: string; message_id: string | null } | null;
};

const SLOTS_OFFERED = [
  /\b(this week or next)\b/i,
  /\b(tue|tues|wed|thu|thur|fri|mon|sat|sun)\w*\b.{0,20}\b(or|and)\b.{0,20}\b(tue|wed|thu|fri|mon)\w*/i,
  /\bwhat (day|time)s? work/i,
  /\b(does|would) (tue|wed|thu|fri|mon)\w*\b.{0,20}\bwork\b/i,
  /\b(morning|afternoon)s?\b.{0,20}\b(or|work)\b/i,
  /\bhere are a couple of times\b/i,
];

const SLOT_SELECTED = [
  /\b(tue|tues|wed|thu|thur|fri|mon|sat|sun)\w*\b.{0,24}\b(works|good|fine|perfect|suits)\b/i,
  /\b(works|good|fine) for me\b/i,
  /\blet'?s do\b/i,
  /\b(i'?m|im) free\b.{0,24}\b(at|on|after|before)\b/i,
  /\b(\d{1,2})(:\d{2})?\s?(am|pm)\b.{0,20}\b(works|good|fine)\b/i,
  /\byep,? that works\b/i,
];

const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/;

const ASKED_FOR_EMAIL = [
  /\bbest email\b/i,
  /\bwhat'?s your email\b/i,
  /\bemail to send\b/i,
  /\bsend (the )?invite to\b/i,
  /\bwhere should i send\b/i,
];

const INVITE_SENT = [
  /\b(sent|sending|just sent) (you )?(the |a )?(invite|calendar|invitation|link)\b/i,
  /\bcalendar invite\b/i,
  /\byou should (have|see) (it|the invite)\b/i,
];

const CONFIRMED = [
  /\b(got it|received|accepted|confirmed)\b.{0,24}\b(invite|calendar|it)\b/i,
  /\bsee you (then|on|at|next|tomorrow|mon|tue|tues|wed|thu|thur|fri)\w*\b/i,
  /\b(accepted|added) (it )?to my calendar\b/i,
  /\bbooked in\b/i,
];

function lastMatch(
  messages: Message[],
  patterns: RegExp[],
  sender: Message["sender"],
): { index: number; quote: string; message_id: string | null } | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.sender !== sender) continue;
    const text = (m.message_text ?? "").trim();
    if (text && patterns.some((re) => re.test(text))) {
      return { index: i, quote: text.slice(0, 200), message_id: m.id ?? null };
    }
  }
  return null;
}

/**
 * Works out how far into booking this conversation actually is.
 *
 * Read backwards from the furthest state, so a thread that has already produced
 * an email address is never mistaken for one that still needs slots.
 */
export function assessBooking(messages: Message[], gatePassed: boolean): BookingAssessment {
  const invited = lastMatch(messages, INVITE_SENT, "setter");
  const confirmed = lastMatch(messages, CONFIRMED, "prospect");

  // Confirmation only counts once there is an invite to confirm: "sounds good"
  // before anything was sent is agreement, not a booking.
  if (confirmed && invited && confirmed.index > invited.index) {
    return {
      state: "booked",
      next_action: "Confirmed. Do not sell further — leave it with Avo.",
      evidence: { quote: confirmed.quote, message_id: confirmed.message_id },
    };
  }

  if (invited) {
    return {
      state: "invite_pending",
      next_action: "The invite is out. Confirm they have it, once, and stop.",
      evidence: { quote: invited.quote, message_id: invited.message_id },
    };
  }

  const emailGiven = messages.some((m) => m.sender === "prospect" && EMAIL.test(m.message_text ?? ""));
  const selected = lastMatch(messages, SLOT_SELECTED, "prospect");
  const offered = lastMatch(messages, SLOTS_OFFERED, "setter");

  if (selected && emailGiven) {
    return {
      state: "invite_pending",
      next_action: "Time and email are both in. Send the invite and say it is on the way.",
      evidence: { quote: selected.quote, message_id: selected.message_id },
    };
  }
  if (selected) {
    const asked = lastMatch(messages, ASKED_FOR_EMAIL, "setter");
    return {
      state: asked ? "email_needed" : "slot_selected",
      next_action: asked
        ? "We have asked for the email and it has not arrived. Ask once more, plainly, and nothing else."
        : "They picked a time. Ask for the email address to send the invite to — that is the whole message.",
      evidence: { quote: selected.quote, message_id: selected.message_id },
    };
  }
  if (offered) {
    return {
      state: "slots_offered",
      next_action: "Slots are on the table. Wait for a time, or restate the two options once. Do not re-pitch.",
      evidence: { quote: offered.quote, message_id: offered.message_id },
    };
  }
  if (gatePassed) {
    return { state: "call_ready", next_action: "Propose the call and offer two concrete times.", evidence: null };
  }
  return { state: "not_ready", next_action: "Qualification is not met. Do not raise a call.", evidence: null };
}

// ---------------------------------------------------------------------------
// No-show risk
// ---------------------------------------------------------------------------

export const NO_SHOW_RISKS = ["low", "medium", "high"] as const;
export type NoShowRisk = (typeof NO_SHOW_RISKS)[number];

export type NoShowAssessment = {
  risk: NoShowRisk;
  score: number;
  factors: string[];
  /** What to do about it before the call, in one line. */
  mitigation: string;
};

/**
 * Estimates the risk that a booked call is not honoured.
 *
 * Derived from what actually separated honoured from unhonoured calls in the
 * historical corpus: bookings agreed quickly, on enthusiasm alone, without the
 * prospect ever showing they understood what the call was for.
 */
export function assessNoShowRisk(input: {
  messages: Message[];
  qualification: Qualification;
  dialogue: DialogueState;
  booking: BookingAssessment;
}): NoShowAssessment {
  const { messages, qualification, dialogue, booking } = input;
  const factors: string[] = [];
  let score = 0;

  if (qualification.service_understanding < 2) {
    score += 3;
    factors.push("They have not clearly shown they understand what the call is for.");
  }
  if (qualification.commercial_goal < 2) {
    score += 2;
    factors.push("No concrete goal of their own on the table.");
  }
  if (qualification.media_gap === 0) {
    score += 2;
    factors.push("They have not acknowledged a gap, so nothing is urgent for them.");
  }

  const prospectMessages = messages.filter((m) => m.sender === "prospect");
  if (prospectMessages.length <= 3) {
    score += 2;
    factors.push(`Only ${prospectMessages.length} replies before booking — agreed fast, invested little.`);
  }

  const askedSomething = prospectMessages.some((m) => (m.message_text ?? "").includes("?"));
  if (!askedSomething) {
    score += 2;
    factors.push("They have never asked us a question. Interest is passive.");
  }

  const avgWords =
    prospectMessages.length === 0
      ? 0
      : prospectMessages.reduce((sum, m) => sum + (m.message_text ?? "").trim().split(/\s+/).length, 0) /
        prospectMessages.length;
  if (prospectMessages.length > 0 && avgWords < 6) {
    score += 1;
    factors.push("Replies are very short throughout.");
  }

  if (booking.state === "email_needed" || booking.state === "slot_selected") {
    score += 1;
    factors.push("No email address yet, so no calendar invite is holding the slot.");
  }
  if (!dialogue.topics.contact_details.answered && booking.state === "invite_pending") {
    score += 1;
    factors.push("The invite has no confirmed address behind it.");
  }

  const risk: NoShowRisk = score >= 7 ? "high" : score >= 4 ? "medium" : "low";
  const mitigation =
    risk === "high"
      ? "Do not book yet. Get the goal and the gap in their own words first — a call agreed on politeness will not be honoured."
      : risk === "medium"
        ? "Book, but confirm the purpose of the call in their words and get the invite into their calendar."
        : "Send the invite and confirm it. Nothing else is needed.";

  return { risk, score, factors, mitigation };
}
