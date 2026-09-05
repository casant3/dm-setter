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
// Concrete call slots
// ---------------------------------------------------------------------------

/**
 * Two specific times, offered in the same message as the call itself.
 *
 * "Would you like a call?" → "yes" → "here are two times" spends a whole turn
 * getting an answer we already had. Once the gate is open the invitation and the
 * options are one move, so the reply we are asking for is a time rather than a
 * second yes.
 */
export type CallSlot = {
  /** The day, as the prospect would say it: "Monday", "Tuesday". */
  day: string;
  /** The part of the day, with an hour range: "2–5:30" or "afternoon". */
  window: string;
  /** Both together, ready to drop into a sentence. */
  label: string;
  /** ISO date of the day being offered, for the record. */
  date: string;
};

export type SlotProposal = {
  slots: CallSlot[];
  /** Only ever the prospect's real timezone. Null when we do not know it. */
  timezone: string | null;
  /** How to say the times given what we know about where they are. */
  timezone_note: string;
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Windows are alternated so the two options are not the same shape of slot. */
const WINDOWS = ["2–5:30", "morning", "afternoon", "10–12:30"];

function addDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/**
 * Picks the next two sensible working days.
 *
 * Never today — a DM answered six hours later would be proposing a time that has
 * already passed — never a weekend, and never further out than a week: an
 * obviously inconvenient date reads as a diary that is either empty or full, and
 * both lose the call.
 */
export function proposeSlots(options: { now?: Date; timezone?: string | null; count?: number } = {}): SlotProposal {
  const now = options.now ?? new Date();
  const timezone = options.timezone?.trim() || null;
  const count = options.count ?? 2;

  const slots: CallSlot[] = [];
  for (let offset = 1; offset <= 9 && slots.length < count; offset += 1) {
    const day = addDays(now, offset);
    const weekday = day.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const window = WINDOWS[slots.length % WINDOWS.length];
    slots.push({
      day: DAY_NAMES[weekday],
      window,
      label: `${DAY_NAMES[weekday]} ${window}`,
      date: day.toISOString().slice(0, 10),
    });
  }

  return {
    slots,
    timezone,
    timezone_note: timezone
      ? `They are in ${timezone}. Give the times in their timezone and say so once.`
      : "We do not know their timezone. Offer the days and rough windows without naming a timezone, and let them anchor it — never state a timezone we are guessing at.",
  };
}

/**
 * A timezone the prospect has actually stated.
 *
 * Only their own words count. Guessing a timezone from a follower count, a
 * location field or a niche produces an invite an hour out, which is the same
 * thing as not turning up.
 */
const STATED_TIMEZONE: { re: RegExp; zone: string }[] = [
  { re: /\b(est|edt|eastern time)\b/i, zone: "US Eastern" },
  { re: /\b(pst|pdt|pacific time)\b/i, zone: "US Pacific" },
  { re: /\b(cst|cdt|central time)\b/i, zone: "US Central" },
  { re: /\b(mst|mdt|mountain time)\b/i, zone: "US Mountain" },
  { re: /\b(gmt|bst|uk time|london time)\b/i, zone: "UK" },
  { re: /\b(cet|cest|central european)\b/i, zone: "Central European" },
  { re: /\b(aest|aedt|sydney time|melbourne time)\b/i, zone: "Australian Eastern" },
  { re: /\bi'?m (based )?in (the )?(uk|london)\b/i, zone: "UK" },
  { re: /\bi'?m (based )?in (new york|nyc)\b/i, zone: "US Eastern" },
  { re: /\butc\s?[+-]\s?\d{1,2}\b/i, zone: "the UTC offset they gave" },
];

export function detectStatedTimezone(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.sender !== "prospect") continue;
    const text = m.message_text ?? "";
    for (const { re, zone } of STATED_TIMEZONE) {
      if (re.test(text)) return zone;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// No-show risk — advisory only
// ---------------------------------------------------------------------------

export const NO_SHOW_RISKS = ["low", "medium", "high"] as const;
export type NoShowRisk = (typeof NO_SHOW_RISKS)[number];

/** How a risky booking should be handled differently. Never whether to book. */
export type NoShowGuidance = {
  /** How hard to make the purpose of the call explicit. */
  frame_purpose: string;
  /** What to do about the time itself. */
  logistics: string;
  /** How much commitment to ask for. */
  commitment: string;
  /** What to do after it is in the calendar. */
  followup: string;
};

export type NoShowAssessment = {
  risk: NoShowRisk;
  score: number;
  factors: string[];
  /**
   * Always true. Qualification decides whether a call may be offered; this only
   * decides how it is offered. A qualified prospect is never withheld a call
   * because a heuristic dislikes the shape of their replies.
   */
  advisory: true;
  guidance: NoShowGuidance;
  /** One line for the UI, phrased as an adaptation rather than a veto. */
  mitigation: string;
};

const GUIDANCE: Record<NoShowRisk, NoShowGuidance> = {
  low: {
    frame_purpose: "One line on what the call is for is enough.",
    logistics: "Offer two concrete times and send the invite.",
    commitment: "No extra commitment needed — they are invested.",
    followup: "Confirm the invite landed. Nothing else.",
  },
  medium: {
    frame_purpose: "Say plainly what the call will cover, in terms of their own goal, before offering times.",
    logistics: "Offer two concrete times rather than asking what suits — a vague time is a missed one.",
    commitment: "Get an explicit yes to a specific slot, not a general 'sounds good'.",
    followup: "Get the invite into their calendar the same day and confirm they have it.",
  },
  high: {
    frame_purpose:
      "Make the purpose unmistakable and specific to what they told us — a call whose point is unclear is the one that gets forgotten.",
    logistics:
      "Offer two concrete, near-term times. Avoid anything more than a few days out, and avoid times they have already implied are bad.",
    commitment:
      "Ask them to confirm the exact slot in their own words, and get the email in the same exchange so the invite is not left hanging.",
    followup: "Send the invite immediately, confirm receipt, and nudge once the day before.",
  },
};

/**
 * Estimates the risk that a booked call is not honoured.
 *
 * Derived from what actually separated honoured from unhonoured calls in the
 * historical corpus: bookings agreed quickly, on enthusiasm alone, without the
 * prospect ever showing they understood what the call was for.
 *
 * This is advice about HOW to book, not permission to book. Qualification is the
 * only gate: terse replies, a short thread and a prospect who has asked us
 * nothing are real risk signals, but none of them is a disqualification, and
 * treating them as one turned a heuristic into a second gate that could veto a
 * fully qualified lead.
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
  const guidance = GUIDANCE[risk];
  const mitigation =
    risk === "high"
      ? `Book, but book it carefully. ${guidance.frame_purpose} ${guidance.commitment}`
      : risk === "medium"
        ? `${guidance.frame_purpose} ${guidance.followup}`
        : guidance.followup;

  return { risk, score, factors, advisory: true, guidance, mitigation };
}
