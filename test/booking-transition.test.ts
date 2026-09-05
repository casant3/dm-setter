import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessBooking,
  assessNoShowRisk,
  detectStatedTimezone,
  proposeSlots,
} from "@/core/booking";
import { buildDialogueState } from "@/core/dialogue-state";
import { auditMoves, countConcreteTimeOptions, planMessage } from "@/core/message-plan";
import { classifyBrushOff } from "@/core/brush-off";
import { assessTemperature } from "@/core/temperature";
import { assessUnderstanding } from "@/core/understanding";
import type { GateResult, Message, Qualification } from "@/lib/types";

/**
 * The booking transition, and the rule that qualification is the only gate.
 *
 * All fixtures are synthetic.
 */

function msg(sender: Message["sender"], text: string, i = 0): Message {
  return {
    id: `m${i}`,
    lead_id: "l1",
    sender,
    message_text: text,
    message_type: "text",
    sent_at: new Date(2026, 0, i + 1).toISOString(),
    channel: "instagram",
    is_question: null,
    is_cta: null,
    is_objection: null,
    is_buying_signal: null,
    sent_by_ai: null,
    ai_suggestion_id: null,
  };
}

function thread(...pairs: [Message["sender"], string][]): Message[] {
  return pairs.map(([s, t], i) => msg(s, t, i));
}

const FULL: Qualification = {
  fit: 2,
  commercial_goal: 2,
  media_gap: 2,
  value_established: 2,
  service_understanding: 2,
  interest_signal: 2,
};

function gate(passed: boolean): GateResult {
  return passed
    ? { passed: true, blockers: [], missing_dimensions: [], total_score: 12, model_said_call_ready: true }
    : {
        passed: false,
        blockers: ["No commercial goal"],
        missing_dimensions: ["commercial_goal"],
        total_score: 5,
        model_said_call_ready: true,
      };
}

function planFor(messages: Message[], passed: boolean, qualification: Qualification = FULL) {
  const prospect = messages.filter((m) => m.sender === "prospect");
  const understanding = assessUnderstanding(prospect, true);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, passed);
  const noShow = assessNoShowRisk({ messages, qualification, dialogue, booking });
  const plan = planMessage({
    dialogue,
    understanding,
    brushOff: classifyBrushOff(prospect[prospect.length - 1] ?? null, {
      understandsService: understanding.level >= 2,
      serviceExplained: true,
    }),
    temperature: assessTemperature(messages, dialogue),
    gate: gate(passed),
    clarificationSpent: false,
    booking,
    noShow,
    slotProposal: proposeSlots({ now: new Date("2026-03-02T09:00:00Z") }),
  });
  return { plan, noShow, booking };
}

// ---------------------------------------------------------------------------
// 1. A terse but qualified prospect is still offered the call
// ---------------------------------------------------------------------------

/** Short replies, no questions asked, few messages: every no-show signal at once. */
const TERSE = thread(
  ["setter", "what are you building toward?"],
  ["prospect", "second clinic Q1"],
  ["setter", "and what comes up when people look you up?"],
  ["prospect", "nothing much"],
  ["setter", "that's the gap — third-party credibility is what fixes it"],
  ["prospect", "yeah makes sense"],
);

/** Passes the gate (11/12, every dimension above zero) but trips every risk signal. */
const TERSE_QUALIFICATION: Qualification = { ...FULL, service_understanding: 1 };

test("a qualified but terse prospect is still offered the call", () => {
  const { plan, noShow } = planFor(TERSE, true, TERSE_QUALIFICATION);

  assert.equal(noShow.risk, "high", "the heuristic still reads this as risky");
  assert.equal(plan.move, "offer_call", "and it does not stop the booking");
  assert.ok(!plan.forbidden.some((f) => f.move === "offer_call"));
  assert.ok(plan.slots.length >= 2);
});

test("high risk changes how the call is framed, not whether it is offered", () => {
  const { plan, noShow } = planFor(TERSE, true, TERSE_QUALIFICATION);

  assert.equal(noShow.advisory, true);
  assert.match(plan.risk_adaptation ?? "", /no-show risk is high/i);
  // The adaptation is about framing, commitment and logistics.
  assert.match(noShow.guidance.frame_purpose, /purpose/i);
  assert.match(noShow.guidance.commitment, /confirm|explicit/i);
  assert.match(noShow.guidance.logistics, /concrete|two/i);
  // And never about withholding the call.
  for (const line of [noShow.mitigation, noShow.guidance.frame_purpose, noShow.guidance.logistics]) {
    assert.doesNotMatch(line, /do not book|don'?t book|not ready for a call/i);
  }
});

test("none of the individual risk signals can close the gate on its own", () => {
  // Few messages, no question asked, short replies, understanding at 1.
  const messages = thread(["setter", "worth building the credibility before the launch"], ["prospect", "agreed"]);
  const { plan, noShow } = planFor(messages, true, { ...FULL, service_understanding: 1 });

  assert.ok(noShow.score > 0, "the signals are still recorded");
  assert.equal(plan.move, "offer_call");
});

// ---------------------------------------------------------------------------
// 2. A failed gate still stops everything
// ---------------------------------------------------------------------------

test("no-show risk can never override a failed qualification gate", () => {
  // Low risk on every axis — long, engaged, question-asking replies.
  const messages = thread(
    ["setter", "what are you working on?"],
    ["prospect", "we're launching a second clinic in Q1 and I want to be the name people find first"],
    ["prospect", "what does working with you actually involve? how much do you charge?"],
    ["prospect", "honestly this is interesting, I've been thinking about press for a while now"],
  );
  const { plan, noShow } = planFor(messages, false);

  assert.equal(noShow.risk, "low", "this prospect looks nothing like a no-show");
  assert.notEqual(plan.move, "offer_call", "and the call is still refused, because the gate is shut");
  assert.ok(plan.forbidden.some((f) => f.move === "offer_call"));
});

// ---------------------------------------------------------------------------
// 3. CALL_READY offers concrete times in the same message
// ---------------------------------------------------------------------------

test("the call-ready plan offers two concrete times immediately", () => {
  const { plan } = planFor(TERSE, true);

  assert.equal(plan.move, "offer_call");
  assert.equal(plan.slots.length, 2);
  assert.notEqual(plan.slots[0].day, plan.slots[1].day, "two different days");
  assert.match(plan.desired_response, /one of the two times/i);
  assert.match(plan.next_if_positive, /email/i, "a picked time leads straight to logistics");
});

test("a draft that asks what day suits instead of offering times is rejected", () => {
  const { plan } = planFor(TERSE, true);

  const vague = "Worth getting you on with Avo — what day works for you this week or next?";
  assert.ok(auditMoves(vague, plan).violations.some((v) => /two concrete times/i.test(v)));

  const concrete = `Makes sense. Best next step is a quick chat with Avo — I've got ${plan.slots[0].label} or ${plan.slots[1].label}, either work?`;
  assert.deepEqual(auditMoves(concrete, plan).violations, []);
});

test("slots skip weekends and never propose today", () => {
  // 2026-03-06 is a Friday.
  const friday = proposeSlots({ now: new Date("2026-03-06T09:00:00Z") });
  assert.deepEqual(
    friday.slots.map((s) => s.day),
    ["Monday", "Tuesday"],
    "Saturday and Sunday are skipped",
  );
  assert.ok(friday.slots.every((s) => s.date > "2026-03-06"), "nothing is offered for today");
  assert.ok(friday.slots.every((s) => s.date <= "2026-03-13"), "and nothing is a fortnight away");
});

test("a timezone is used when they gave one and never invented when they did not", () => {
  const unknown = proposeSlots({ now: new Date("2026-03-02T09:00:00Z") });
  assert.equal(unknown.timezone, null);
  assert.match(unknown.timezone_note, /do not know their timezone/i);

  const stated = detectStatedTimezone(thread(["setter", "when suits?"], ["prospect", "I'm EST if that helps"]));
  assert.equal(stated, "US Eastern");
  const known = proposeSlots({ now: new Date("2026-03-02T09:00:00Z"), timezone: stated });
  assert.match(known.timezone_note, /US Eastern/);

  assert.equal(detectStatedTimezone(thread(["prospect", "I'm in Manchester"])), null, "a place is not a timezone");
});

test("counting concrete options ignores vague availability", () => {
  assert.ok(countConcreteTimeOptions("this week or next?") < 2);
  assert.ok(countConcreteTimeOptions("what day works for you?") < 2);
  assert.ok(countConcreteTimeOptions("Monday 2–5:30 or Tuesday afternoon") >= 2);
  assert.ok(countConcreteTimeOptions("Thursday at 10am or 3pm") >= 2);
});

// ---------------------------------------------------------------------------
// 4. Once a slot is picked, the call is not proposed again
// ---------------------------------------------------------------------------

const PICKED = thread(
  ["setter", "worth a quick chat with Avo — I've got Monday 2–5:30 or Tuesday afternoon, either work?"],
  ["prospect", "Tuesday 3 works"],
);

test("a selected slot moves to logistics and never re-proposes the call", () => {
  const { plan, booking } = planFor(PICKED, true);

  assert.equal(booking.state, "slot_selected");
  assert.equal(plan.move, "arrange_logistics");
  assert.match(plan.desired_response, /email/i);
  assert.equal(plan.slots.length, 0, "no new times are offered once one is agreed");
  assert.ok(plan.forbidden.some((f) => f.move === "build_value"));
  assert.ok(plan.forbidden.some((f) => f.move === "ask_discovery"));
});

test("re-pitching after a slot is agreed is caught by the audit", () => {
  const { plan } = planFor(PICKED, true);

  const good = "Perfect. What's the best email to send the calendar invite to?";
  assert.deepEqual(auditMoves(good, plan).violations, []);

  const reProposed = "Great — worth grabbing 20 minutes with Avo, what day works for you?";
  assert.ok(
    auditMoves(reProposed, plan).violations.some((v) => /already agreed/i.test(v)),
    "re-proposing a call that is already agreed is a violation",
  );
  // And discovery is forbidden outright by the plan.
  assert.ok(plan.forbidden.some((f) => f.move === "ask_discovery"));
});

test("an email already given moves straight to the invite", () => {
  const messages = [...PICKED, msg("prospect", "sam@clinic.com", 2)];
  const { booking, plan } = planFor(messages, true);

  assert.equal(booking.state, "invite_pending");
  assert.equal(plan.move, "arrange_logistics");
  assert.match(plan.desired_response, /confirmation/i);
});
