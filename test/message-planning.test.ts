import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDialogueState } from "@/core/dialogue-state";
import { assessQualificationEvidence, reconcileQualification, verifyQuote } from "@/core/qualification-evidence";
import { assessStyle, countWords } from "@/core/style";
import { auditMoves, planMessage } from "@/core/message-plan";
import { auditDraft } from "@/core/audit";
import { assessBooking, assessNoShowRisk } from "@/core/booking";
import { assessMotivation } from "@/core/motivation";
import { classifyBrushOff } from "@/core/brush-off";
import { assessTemperature } from "@/core/temperature";
import { assessUnderstanding } from "@/core/understanding";
import { emptyMemory } from "@/core/memory";
import type { GateResult, Lead, Message, Qualification } from "@/lib/types";

/** All fixtures synthetic. */
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

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: "l1",
    instagram_handle: "someone",
    name: "Sam",
    company: null,
    job_title: null,
    industry: null,
    niche: null,
    followers: null,
    location: null,
    commercial_goal: null,
    media_gap: null,
    media_experience: null,
    authority_level: null,
    conversation_stage: "opening",
    interest_level: null,
    priority: null,
    followup_status: null,
    notes: null,
    created_at: new Date(2026, 0, 1).toISOString(),
    updated_at: null,
  } as unknown as Lead;
}

function evidenceFor(messages: Message[], overrides: Partial<Lead> = {}) {
  const prospect = messages.filter((m) => m.sender === "prospect");
  const understanding = assessUnderstanding(prospect, false);
  const dialogue = buildDialogueState(messages, null);
  return {
    understanding,
    dialogue,
    evidence: assessQualificationEvidence({
      lead: lead(overrides),
      memory: null,
      messages,
      dialogue,
      understanding,
    }),
  };
}

const FULL: Qualification = {
  fit: 2,
  commercial_goal: 2,
  media_gap: 2,
  value_established: 2,
  service_understanding: 2,
  interest_signal: 2,
};

// ---------------------------------------------------------------------------
// Evidence behind every dimension
// ---------------------------------------------------------------------------

test("a dimension with nothing behind it scores zero however confident the model is", () => {
  const messages = thread(["setter", "hey"], ["prospect", "hi"]);
  const { evidence } = evidenceFor(messages);

  const { qualification, adjustments } = reconcileQualification(FULL, evidence, [], messages);
  assert.equal(qualification.commercial_goal, 0);
  assert.equal(qualification.media_gap, 0);
  assert.equal(qualification.interest_signal, 0);
  assert.ok(adjustments.length >= 3, "every reduction is recorded");
  assert.ok(adjustments.some((a) => /commercial_goal: 2 → 0/.test(a)));
});

test("evidence carries the prospect's own words and where they came from", () => {
  const messages = thread(
    ["setter", "what are you building?"],
    ["prospect", "I'm launching a supplement brand in Q1"],
    ["setter", "what comes up when someone looks you up?"],
    ["prospect", "honestly not much, no press at all"],
  );
  const { evidence } = evidenceFor(messages);

  assert.ok(evidence.commercial_goal.evidenced >= 1);
  assert.match(evidence.commercial_goal.quotes[0].quote, /supplement brand/);
  assert.equal(evidence.media_gap.quotes[0].source, "prospect");
  assert.match(evidence.media_gap.reason, /acknowledged the gap themselves/i);
});

test("a profile note alone is our assumption, not their acknowledgement", () => {
  const messages = thread(["setter", "hey"], ["prospect", "hey"]);
  const { evidence } = evidenceFor(messages, {});
  assert.equal(evidence.media_gap.evidenced, 0);

  const withProfile = assessQualificationEvidence({
    lead: { ...lead(), media_gap: "nothing but social profiles" } as Lead,
    memory: null,
    messages,
    dialogue: buildDialogueState(messages, null),
    understanding: assessUnderstanding([], false),
  });
  assert.equal(withProfile.media_gap.evidenced, 1, "our note is worth one point, not two");
  assert.match(withProfile.media_gap.reason, /not acknowledged/i);
});

test("a verified quote earns one point of benefit of the doubt", () => {
  const messages = thread(
    ["setter", "what are you working on?"],
    ["prospect", "mainly getting the clinic in front of the right patients"],
  );
  const { evidence } = evidenceFor(messages);
  const before = reconcileQualification(FULL, evidence, [], messages).qualification.commercial_goal;

  const after = reconcileQualification(
    FULL,
    evidence,
    [{ dimension: "commercial_goal", quote: "getting the clinic in front of the right patients" }],
    messages,
  ).qualification.commercial_goal;

  assert.equal(after, before + 1, "a real quote is worth exactly one extra point");
});

test("an invented quote earns nothing and is reported", () => {
  const messages = thread(["setter", "hey"], ["prospect", "hey there"]);
  const { evidence } = evidenceFor(messages);

  const { qualification, adjustments } = reconcileQualification(
    FULL,
    evidence,
    [{ dimension: "media_gap", quote: "I really need press coverage before my launch" }],
    messages,
  );
  assert.equal(qualification.media_gap, 0);
  assert.ok(adjustments.some((a) => /not found in the conversation/.test(a)));
});

test("service_understanding gets no benefit of the doubt at all", () => {
  const messages = thread(["setter", "we work with clients on this"], ["prospect", "cool"]);
  const { evidence } = evidenceFor(messages);
  const { qualification } = reconcileQualification(
    FULL,
    evidence,
    [{ dimension: "service_understanding", quote: "we work with clients on this" }],
    messages,
  );
  assert.equal(qualification.service_understanding, 0, "our own words can never evidence their understanding");
});

test("quote verification ignores punctuation but not invention", () => {
  const messages = thread(["prospect", "Yeah — I'm launching in Q1, so timing matters!"]);
  assert.equal(verifyQuote("im launching in q1 so timing matters", messages).found, true);
  assert.equal(verifyQuote("I'm launching in Q2", messages).found, false);
});

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

test("a long draft is a hard failure", () => {
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
  const s = assessStyle(long);
  assert.equal(s.ok, false);
  assert.ok(s.violations.some((v) => v.rule === "length" && v.severity === "hard"));
  assert.equal(s.words, 80);
});

test("two questions in one DM is a hard failure", () => {
  const s = assessStyle("What are you building toward this year? And what comes up when people search you?");
  assert.equal(s.questions, 2);
  assert.ok(s.violations.some((v) => v.rule === "one_question" && v.severity === "hard"));
});

test("a well-shaped Cassey-length DM passes", () => {
  const draft = "Makes sense. When someone hears about you and goes looking, what actually comes up right now?";
  const s = assessStyle(draft);
  assert.equal(s.ok, true, JSON.stringify(s.violations));
  assert.ok(countWords(draft) <= 45);
});

test("corporate and hype language are caught", () => {
  assert.ok(assessStyle("I hope this finds you well, I wanted to touch base about leveraging synergies").violations.length >= 2);
  assert.ok(assessStyle("This is an amazing opportunity, guaranteed results!!").violations.some((v) => v.rule === "voice"));
});

// ---------------------------------------------------------------------------
// One move per message, and the forward path
// ---------------------------------------------------------------------------

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    passed: false,
    blockers: ["No commercial goal"],
    missing_dimensions: ["commercial_goal"],
    total_score: 4,
    model_said_call_ready: false,
    ...overrides,
  };
}

function planFor(messages: Message[], gateResult: GateResult, opts: { clarificationSpent?: boolean } = {}) {
  const prospect = messages.filter((m) => m.sender === "prospect");
  const understanding = assessUnderstanding(prospect, false);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, gateResult.passed);
  const qualification = gateResult.passed ? FULL : { ...FULL, commercial_goal: 0 };
  return planMessage({
    dialogue,
    understanding,
    brushOff: classifyBrushOff(prospect[prospect.length - 1] ?? null, {
      understandsService: understanding.level >= 2,
      serviceExplained: false,
    }),
    temperature: assessTemperature(messages, dialogue),
    gate: gateResult,
    clarificationSpent: opts.clarificationSpent ?? false,
    booking,
    noShow: assessNoShowRisk({ messages, qualification, dialogue, booking }),
  });
}

test("every plan has a purpose and a defined path for yes, no and silence", () => {
  const p = planFor(thread(["setter", "hey"], ["prospect", "hi"]), gate());
  assert.ok(p.purpose.length > 0);
  assert.ok(p.desired_response.length > 0);
  assert.ok(p.next_if_positive.length > 0);
  assert.ok(p.next_if_negative.length > 0);
  assert.ok(p.next_if_no_reply.length > 0);
});

test("a call is a forbidden move until the gate opens", () => {
  const p = planFor(thread(["setter", "hey"], ["prospect", "hi"]), gate());
  assert.ok(p.forbidden.some((f) => f.move === "offer_call"));
  const violations = auditMoves("Want to grab 20 minutes with Avo this week or next?", p).violations;
  assert.ok(violations.some((v) => /forbidden/i.test(v)));
});

test("an open gate plans the call and allows it", () => {
  const p = planFor(
    thread(["setter", "here's what we do"], ["prospect", "that makes sense, how much do you charge?"]),
    gate({ passed: true, blockers: [], missing_dimensions: [], total_score: 11 }),
  );
  assert.equal(p.move, "offer_call");
  assert.ok(!p.forbidden.some((f) => f.move === "offer_call"));
  assert.equal(auditMoves("Worth a quick call with Avo — what day works this week?", p).violations.length, 0);
});

test("an informed rejection plans a stop, not another attempt", () => {
  const messages = thread(
    ["setter", "we work with clients on written media and search presence"],
    ["prospect", "so you work with your clients on the search side too?"],
    ["prospect", "I'm good thanks"],
  );
  const prospect = messages.filter((m) => m.sender === "prospect");
  const understanding = assessUnderstanding(prospect, true);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, false);
  const p = planMessage({
    dialogue,
    understanding,
    brushOff: classifyBrushOff(prospect[prospect.length - 1], { understandsService: true, serviceExplained: true }),
    temperature: assessTemperature(messages, dialogue),
    gate: gate(),
    clarificationSpent: false,
    booking,
    noShow: assessNoShowRisk({ messages, qualification: FULL, dialogue, booking }),
  });
  assert.equal(p.move, "respect_rejection");
  assert.ok(auditMoves("Totally understand — can I ask what put you off?", p).violations.some((v) => /persistence/i.test(v)));
});

test("service confusion outranks discovery", () => {
  const p = planFor(thread(["setter", "hey"], ["prospect", "how long is the pod?"]), gate());
  assert.equal(p.move, "correct_premise");
});

test("a cost question before any explanation plans commercial clarity, not a premise correction", () => {
  const p = planFor(thread(["setter", "hey, saw your work"], ["prospect", "is there a cost?"]), gate());
  assert.equal(p.move, "clarify_commercial");
});

test("the one clarification allowance changes the plan once it is spent", () => {
  const messages = thread(["setter", "hey"], ["prospect", "I'm good thanks"]);
  assert.equal(planFor(messages, gate()).move, "clarify_after_brushoff");
  assert.notEqual(planFor(messages, gate(), { clarificationSpent: true }).move, "clarify_after_brushoff");
});

test("a question and a call proposal in one message is two moves", () => {
  const p = planFor(
    thread(["setter", "hey"], ["prospect", "I'm building a clinic, open to hearing more"]),
    gate({ passed: false, missing_dimensions: ["media_gap"] }),
  );
  const audit = auditMoves("What comes up when people search you? Also want to grab 20 minutes with Avo?", p);
  assert.ok(audit.violations.length >= 1);
  assert.ok(audit.violations.some((v) => /two moves|two or more questions/i.test(v)));
});

test("a discovery plan answered with a statement is caught", () => {
  const p = planFor(thread(["setter", "hey"], ["prospect", "hi"]), gate());
  assert.equal(p.move, "ask_discovery");
  assert.ok(auditMoves("We help founders build authority through written media.", p).violations.some((v) => /statement/i.test(v)));
});

// ---------------------------------------------------------------------------
// The combined audit
// ---------------------------------------------------------------------------

test("the audit catches re-asking something already answered", () => {
  const messages = thread(
    ["setter", "would you be open to hearing more?"],
    ["prospect", "yeah I'm always open to opportunities"],
  );
  const dialogue = buildDialogueState(messages, null);
  const plan = planFor(messages, gate());
  const audit = auditDraft("Would that be something you'd be open to exploring?", {
    dialogue,
    motivation: assessMotivation([], null),
    plan,
  });
  assert.equal(audit.ok, false);
  assert.ok(audit.violations.some((v) => v.rule === "already_answered"));
});

test("the audit catches money framing at a mission-driven prospect", () => {
  const messages = thread(["setter", "hey"], ["prospect", "I'm mainly trying to educate more patients properly"]);
  const audit = auditDraft("What revenue are you trying to generate from your media?", {
    dialogue: buildDialogueState(messages, null),
    motivation: assessMotivation(messages.filter((m) => m.sender === "prospect"), null),
    plan: planFor(messages, gate()),
  });
  assert.ok(audit.violations.some((v) => v.rule === "wrong_frame"));
});

test("a clean draft passes the audit", () => {
  const messages = thread(["setter", "hey"], ["prospect", "hey, what's up"]);
  const audit = auditDraft("Quick one — what are you actually building toward over the next few months?", {
    dialogue: buildDialogueState(messages, null),
    motivation: assessMotivation([], null),
    plan: planFor(messages, gate()),
  });
  assert.equal(audit.ok, true, JSON.stringify(audit.violations));
});

test("memory-closed topics also count as answered in the audit", () => {
  const memory = {
    ...emptyMemory("l1"),
    goals: [
      {
        value: "launching a supplement brand",
        provenance: "fact" as const,
        confidence: 1,
        recorded_at: new Date().toISOString(),
        quote: "I'm launching a supplement brand in Q1",
      },
    ],
  };
  const messages = thread(["setter", "hey"], ["prospect", "hey"]);
  const dialogue = buildDialogueState(messages, memory);
  const audit = auditDraft("What are you building toward this year?", {
    dialogue,
    motivation: assessMotivation([], memory),
    plan: planFor(messages, gate()),
  });
  assert.ok(audit.violations.some((v) => v.rule === "already_answered"), "memory closes it even years later");
});

// ---------------------------------------------------------------------------
// Booking as a sequence, and whether the call would be honoured
// ---------------------------------------------------------------------------

test("booking walks through its states rather than jumping to booked", () => {
  const ready = thread(["setter", "worth a quick call with Avo?"], ["prospect", "yeah go on"]);
  assert.equal(assessBooking(ready, true).state, "call_ready");

  const offered = [...ready, msg("setter", "Does Tuesday or Thursday work better?", 2)];
  assert.equal(assessBooking(offered, true).state, "slots_offered");

  const picked = [...offered, msg("prospect", "Thursday works", 3)];
  assert.equal(assessBooking(picked, true).state, "slot_selected");

  const asked = [...picked, msg("setter", "What's the best email to send the invite to?", 4)];
  assert.equal(assessBooking(asked, true).state, "email_needed");

  const emailed = [...asked, msg("prospect", "sam@clinic.com", 5)];
  assert.equal(assessBooking(emailed, true).state, "invite_pending");

  const confirmed = [...emailed, msg("setter", "Just sent the invite", 6), msg("prospect", "got it, see you Thursday", 7)];
  assert.equal(assessBooking(confirmed, true).state, "booked");
});

test("a conversation mid-booking is never sent another pitch for the call", () => {
  const messages = [
    msg("setter", "Does Tuesday or Thursday work better?", 0),
    msg("prospect", "Thursday works", 1),
  ];
  const p = planFor(messages, gate({ passed: true, blockers: [], missing_dimensions: [], total_score: 12 }));
  assert.equal(p.move, "arrange_logistics");
  assert.match(p.purpose, /email/i);
  assert.ok(p.forbidden.some((f) => f.move === "build_value"));
});

test("a booking agreed on politeness alone is flagged as a likely no-show", () => {
  const messages = thread(["setter", "worth a chat with Avo?"], ["prospect", "sure"]);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, true);
  const risk = assessNoShowRisk({
    messages,
    qualification: { ...FULL, service_understanding: 0, commercial_goal: 0, media_gap: 0 },
    dialogue,
    booking,
  });
  assert.equal(risk.risk, "high");
  assert.ok(risk.factors.some((f) => /understand what the call is for/i.test(f)));
  assert.match(risk.mitigation, /do not book yet/i);
});

test("high no-show risk blocks the call even with an open gate", () => {
  const messages = thread(["setter", "worth a chat?"], ["prospect", "sure"]);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, true);
  const p = planMessage({
    dialogue,
    understanding: assessUnderstanding(messages.filter((m) => m.sender === "prospect"), false),
    brushOff: classifyBrushOff(null, { understandsService: false, serviceExplained: false }),
    temperature: assessTemperature(messages, dialogue),
    gate: gate({ passed: true, blockers: [], missing_dimensions: [], total_score: 9 }),
    clarificationSpent: false,
    booking,
    noShow: assessNoShowRisk({
      messages,
      qualification: { ...FULL, service_understanding: 0, commercial_goal: 0, media_gap: 0 },
      dialogue,
      booking,
    }),
  });
  assert.equal(p.move, "build_value");
  assert.ok(p.forbidden.some((f) => f.move === "offer_call"));
});

test("a well-qualified, engaged prospect is a low no-show risk", () => {
  const messages = thread(
    ["setter", "what are you building?"],
    ["prospect", "I'm launching a second clinic in Q1 and want to be the name people find"],
    ["setter", "what comes up when people look you up?"],
    ["prospect", "honestly not much, no press at all — what does working with you look like?"],
  );
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, true);
  const risk = assessNoShowRisk({ messages, qualification: FULL, dialogue, booking });
  assert.equal(risk.risk, "low");
});

// ---------------------------------------------------------------------------
// Cold openers and research
// ---------------------------------------------------------------------------

test("with no reply yet the plan is an opener, not discovery or a pitch", () => {
  const p = planFor(thread(["setter", "hey"]), gate());
  assert.equal(p.move, "cold_opener");
  assert.ok(p.forbidden.some((f) => f.move === "offer_call"));
  assert.ok(p.forbidden.some((f) => f.move === "build_value"));
});

test("an opener uses one verified research fact and never claims to have researched them", () => {
  const messages = thread(["setter", "hey"]);
  const dialogue = buildDialogueState(messages, null);
  const booking = assessBooking(messages, false);
  const p = planMessage({
    dialogue,
    understanding: assessUnderstanding([], false),
    brushOff: classifyBrushOff(null, { understandsService: false, serviceExplained: false }),
    temperature: assessTemperature(messages, dialogue),
    gate: gate(),
    clarificationSpent: false,
    booking,
    noShow: assessNoShowRisk({ messages, qualification: FULL, dialogue, booking }),
    verifiedResearch: [{ value: "they opened a second clinic in Leeds" }],
  });
  assert.match(p.purpose, /second clinic in Leeds/);
  assert.ok(
    auditMoves("I researched you extensively and noticed the second clinic.", p).violations.some((v) =>
      /researched them/i.test(v),
    ),
  );
  assert.equal(auditMoves("Noticed you opened the second clinic in Leeds — what's the plan behind it?", p).violations.length, 0);
});

test("with no verified research the opener does not pretend to know anything", () => {
  const p = planFor(thread(["setter", "hey"]), gate());
  assert.match(p.purpose, /do not imply we know anything about them/i);
});
