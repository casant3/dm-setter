import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSetterForLead, type AgentDeps } from "@/core/agent";
import { buildCoachingLayer, observeEdit, parseChatGptExport, rankCoachingExamples } from "@/core/coaching";
import { loadLeadContext, compactContext, enrichContext } from "@/core/context";
import { offlineLlm } from "@/core/offline-llm";
import { LocalStore } from "@/lib/store/local-store";
import type { CoachingExample, SetterPreference } from "@/lib/types";

async function freshDeps(): Promise<AgentDeps> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-coach-"));
  return { store: new LocalStore(dir), llm: offlineLlm, voiceSetter: "Cassey" };
}

function pref(overrides: Partial<SetterPreference> = {}): SetterPreference {
  return {
    id: "p1",
    setter_name: "Cassey",
    rule: "Never open with 'quick one'",
    applies_to: null,
    source: "human",
    status: "active",
    priority: 10,
    evidence: null,
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function example(overrides: Partial<CoachingExample> = {}): CoachingExample {
  return {
    id: "e1",
    setter_name: "Cassey",
    kind: "good_example",
    situation: "They say they are open to opportunities",
    prospect_message: "always open to opportunities",
    rejected_reply: null,
    operator_feedback: null,
    approved_reply: "Good to know. What are you actually building toward this year?",
    revisions: [],
    why: "Convert the openness into something concrete",
    source: "human",
    status: "approved",
    tags: [],
    applies_when: null,
    approved_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

test("only approved material reaches the layer", () => {
  const layer = buildCoachingLayer({
    preferences: [pref(), pref({ id: "p2", rule: "Proposed but unreviewed", status: "pending_review" })],
    examples: [example(), example({ id: "e2", approved_reply: "unreviewed", status: "pending_review" })],
    liveMessages: [],
  });
  assert.deepEqual(layer.rules, ["Never open with 'quick one'"]);
  assert.equal(layer.examples.length, 1);
});

test("rules are ordered by priority and the precedence is explicit", () => {
  const layer = buildCoachingLayer({
    preferences: [pref({ id: "a", rule: "low", priority: 1 }), pref({ id: "b", rule: "high", priority: 9 })],
    examples: [],
    liveMessages: [],
  });
  assert.deepEqual(layer.rules, ["high", "low"]);
  assert.match(layer.precedence[0], /Explicit rule/i);
  assert.match(layer.note, /higher-numbered rule loses/i);
});

test("a stage-scoped rule only applies to its stage", () => {
  const scoped = pref({ rule: "Do not mention Avo yet", applies_to: "DISCOVERY" });
  assert.deepEqual(buildCoachingLayer({ preferences: [scoped], examples: [], liveMessages: [], stage: "DISCOVERY" }).rules, [
    "Do not mention Avo yet",
  ]);
  assert.deepEqual(buildCoachingLayer({ preferences: [scoped], examples: [], liveMessages: [], stage: "CALL_READY" }).rules, []);
});

// ---------------------------------------------------------------------------
// Learning from live edits
// ---------------------------------------------------------------------------

test("a big cut is read as a length preference", () => {
  const suggested = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const observations = observeEdit(suggested, "Short version instead, seven words here");
  assert.ok(observations.some((o) => /cut this shorter/i.test(o.proposed_rule)));
  assert.ok(observations.every((o) => o.auto_apply === false), "nothing is ever applied automatically");
});

test("a removed call proposal is read as build value first", () => {
  const observations = observeEdit(
    "That makes sense — want to grab 20 minutes with Avo this week?",
    "That makes sense. The part that matters for a launch is having the credibility live before it.",
  );
  assert.ok(observations.some((o) => /build more value/i.test(o.proposed_rule)));
});

test("an added call proposal is read as the draft being too passive", () => {
  const observations = observeEdit(
    "Curious whether that lands for you.",
    "Curious whether that lands — worth a quick call with Avo this week?",
  );
  assert.ok(observations.some((o) => /too passive/i.test(o.proposed_rule)));
});

test("an unchanged message teaches nothing", () => {
  assert.deepEqual(observeEdit("same message", "same message"), []);
});

test("a light reword does not manufacture a rule about length or CTAs", () => {
  const observations = observeEdit(
    "Makes sense. What comes up when someone looks you up right now?",
    "Makes sense. What actually comes up when someone looks you up?",
  );
  assert.ok(!observations.some((o) => /cut this shorter|call proposal/i.test(o.proposed_rule)));
});

// ---------------------------------------------------------------------------
// ChatGPT import
// ---------------------------------------------------------------------------

/**
 * An export where nobody ever said a draft was good.
 *
 * The old importer queued every DM-shaped assistant message as a candidate
 * approved reply. Most assistant messages in a real coaching history are the
 * ones that were rejected, so nothing here may arrive approved.
 */
const EXPORT = [
  {
    title: "DM reply for a founder lead",
    current_node: "c",
    mapping: {
      root: { id: "root", parent: null, children: ["a"], message: null },
      a: {
        id: "a",
        parent: "root",
        children: ["b"],
        message: { author: { role: "user" }, content: { parts: ["How should I reply to this prospect DM?"] }, create_time: 1 },
      },
      b: {
        id: "b",
        parent: "a",
        children: ["c"],
        message: {
          author: { role: "assistant" },
          content: { parts: ["Makes sense — what are you actually building toward this year? Happy to keep it short."] },
          create_time: 2,
        },
      },
      c: {
        id: "c",
        parent: "b",
        children: [],
        message: { author: { role: "user" }, content: { parts: ["he already said that"] }, create_time: 3 },
      },
    },
  },
  {
    title: "Recipe ideas",
    current_node: "b",
    mapping: {
      a: {
        id: "a",
        parent: null,
        children: ["b"],
        message: { author: { role: "user" }, content: { parts: ["what can I cook tonight"] }, create_time: 1 },
      },
      b: {
        id: "b",
        parent: "a",
        children: [],
        message: {
          author: { role: "assistant" },
          content: { parts: ["You could make a risotto with whatever is in the fridge tonight."] },
          create_time: 2,
        },
      },
    },
  },
];

test("a criticised draft is imported as a rejection, never as an approved reply", () => {
  const candidates = parseChatGptExport(EXPORT);
  const dm = candidates.find((c) => c.source_title === "DM reply for a founder lead");

  assert.ok(dm, "the coaching conversation is imported");
  assert.equal(dm.approved_reply, null, "nobody approved anything in it");
  assert.match(dm.rejected_reply ?? "", /building toward/);
  assert.equal(dm.operator_feedback, "he already said that");
  assert.ok(dm.tags.includes("already_answered"));
  assert.match(dm.prospect_message ?? "", /How should I reply/);

  // The unrelated chat has no verdicts in it at all, so it produces nothing.
  assert.ok(!candidates.some((c) => c.source_title === "Recipe ideas"));
});

test("nothing imported is treated as approved", async () => {
  const deps = await freshDeps();
  for (const candidate of parseChatGptExport(EXPORT)) {
    await deps.store.createCoachingExample({
      setter_name: "Cassey",
      kind: candidate.kind,
      situation: candidate.situation,
      prospect_message: candidate.prospect_message,
      rejected_reply: candidate.rejected_reply,
      operator_feedback: candidate.operator_feedback,
      approved_reply: candidate.approved_reply,
      revisions: candidate.revisions,
      why: null,
      source: "chatgpt_import",
      status: "pending_review",
      tags: candidate.tags,
      applies_when: null,
      approved_at: null,
    });
  }
  assert.equal((await deps.store.listCoachingExamples("approved")).length, 0);
  assert.equal((await deps.store.listCoachingExamples("pending_review")).length, 1);
});

// ---------------------------------------------------------------------------
// End to end: what actually reaches the model
// ---------------------------------------------------------------------------

test("an approved rule reaches the model context and a pending one does not", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.getLeadByHandle("codyalt");
  assert.ok(lead);

  await deps.store.createSetterPreference({
    setter_name: "Cassey",
    rule: "Never open with 'quick one'",
    applies_to: null,
    source: "human",
    status: "active",
    priority: 10,
    evidence: null,
    approved_at: new Date().toISOString(),
  });
  await deps.store.createSetterPreference({
    setter_name: "Cassey",
    rule: "Always mention the price immediately",
    applies_to: null,
    source: "live_edit",
    status: "pending_review",
    priority: 0,
    evidence: null,
    approved_at: null,
  });

  const ctx = await loadLeadContext(deps.store, lead!.id, "how long is the pod?");
  const strategy = await offlineLlm.strategy(ctx, "");
  const enriched = await enrichContext(deps.store, ctx, strategy, { voiceSetter: "Cassey" });
  const serialized = compactContext(enriched);

  assert.match(serialized, /Never open with 'quick one'/);
  assert.doesNotMatch(serialized, /Always mention the price immediately/);
  assert.match(serialized, /higher-numbered rule loses/);
});

test("messages actually sent become the live voice reference", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.getLeadByHandle("codyalt");
  const result = await runSetterForLead(lead!.id, "how long is the pod?", deps);
  await deps.store.recordFeedback(result.suggestion_id!, {
    feedback: "edited",
    final_message_sent: "Not a guest spot — we build the media and search presence behind your name.",
  });

  const live = await deps.store.listApprovedLiveMessages(8);
  assert.equal(live.length, 1);
  assert.equal(live[0].edited, true);
  assert.match(live[0].sent, /Not a guest spot/);
});

// ---------------------------------------------------------------------------
// Contextual coaching retrieval
// ---------------------------------------------------------------------------

/** A small library covering the situations the setter moves between. */
const LIBRARY: CoachingExample[] = [
  example({
    id: "opener",
    situation: "Cold opener for a founder",
    approved_reply: "Saw the second site is opening — what's the plan for getting known before it does?",
    tags: ["good_opener", "unnatural_intro"],
  }),
  example({
    id: "value",
    situation: "Building value before any call",
    approved_reply: "Right now anyone searching you finds your own feed and nothing else.",
    tags: ["good_value_build", "premature_cta"],
  }),
  example({
    id: "booking",
    situation: "Moving a warm prospect to the call",
    approved_reply: "Best next step is a quick chat with Avo — I've got Monday 2–5:30 or Tuesday afternoon, either work?",
    tags: ["good_booking_transition"],
  }),
  example({
    id: "guarded",
    situation: "A guarded prospect giving one-word replies",
    approved_reply: "All good — no pitch. What are you focused on at the moment?",
    tags: ["too_pushy", "human_natural_tone"],
  }),
];

test("a booking-stage message prefers booking coaching over cold-opener coaching", () => {
  const layer = buildCoachingLayer({
    preferences: [],
    examples: LIBRARY,
    liveMessages: [],
    situation: { move: "offer_call", temperature: "high_intent", booking_state: "call_ready" },
  });

  assert.equal(layer.examples[0].situation, "Moving a warm prospect to the call");
  assert.ok(
    !layer.examples.some((e) => e.situation.includes("Cold opener")),
    "opener coaching has nothing to say about booking",
  );
  assert.ok(layer.examples[0].relevance.some((r) => /good_booking_transition/.test(r)));
});

test("a guarded prospect prefers low-pressure coaching", () => {
  const layer = buildCoachingLayer({
    preferences: [],
    examples: LIBRARY,
    liveMessages: [],
    situation: { move: "ask_discovery", temperature: "guarded" },
  });

  assert.equal(layer.examples[0].situation, "A guarded prospect giving one-word replies");
});

test("value-building coaching is preferred before a call, and not during one", () => {
  const before = buildCoachingLayer({
    preferences: [],
    examples: LIBRARY,
    liveMessages: [],
    situation: { move: "build_value", temperature: "engaged" },
  });
  assert.equal(before.examples[0].situation, "Building value before any call");

  const during = buildCoachingLayer({
    preferences: [],
    examples: LIBRARY,
    liveMessages: [],
    situation: { move: "offer_call", temperature: "high_intent" },
  });
  assert.ok(
    !during.examples.some((e) => e.tags.includes("premature_cta")),
    "'no call yet' advice must not reach the message that books the call",
  );
});

test("an example scoped to another move is pushed out rather than shown", () => {
  const scoped = example({
    id: "scoped",
    situation: "Only for openers",
    approved_reply: "Noticed the launch — what's the plan behind it?",
    tags: [],
    applies_when: { moves: ["cold_opener"] },
  });

  const ranked = rankCoachingExamples([scoped, LIBRARY[2]], { move: "offer_call" });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].example.id, "booking");
});

test("a correction is carried into the prompt with the reason it was rejected", () => {
  const correction = example({
    id: "correction",
    kind: "correction_chain",
    situation: "He had already said he was open",
    rejected_reply: "Would you be open to hearing more about it?",
    operator_feedback: "he already said that",
    approved_reply: "Good to know. What are you actually building toward this year?",
    tags: ["already_answered", "repeated_question"],
  });

  const layer = buildCoachingLayer({
    preferences: [],
    examples: [correction],
    liveMessages: [],
    situation: { move: "ask_discovery" },
  });

  assert.equal(layer.examples[0].avoid, "Would you be open to hearing more about it?");
  assert.equal(layer.examples[0].because, "he already said that");
  assert.equal(layer.examples[0].kind, "correction_chain");
});

test("explicit rules stay global while examples are narrowed", () => {
  const layer = buildCoachingLayer({
    preferences: [pref({ rule: "Never open with 'quick one'" })],
    examples: LIBRARY,
    liveMessages: [],
    situation: { move: "offer_call", temperature: "high_intent" },
  });

  assert.deepEqual(layer.rules, ["Never open with 'quick one'"]);
  assert.ok(layer.examples.length <= 4, "the prompt never gets the whole library");
  assert.equal(layer.considered, LIBRARY.length);
});

// ---------------------------------------------------------------------------
// Richer live-edit learning
// ---------------------------------------------------------------------------

test("an edit that drops generic praise is read as such", () => {
  const observations = observeEdit(
    "Hey Sam — love what you're doing with the clinic, huge fan of the content. What's the plan for the second site?",
    "Hey Sam — what's the plan for the second site?",
  );
  assert.ok(observations.some((o) => /compliment/i.test(o.proposed_rule)));
  assert.ok(observations.some((o) => o.tags.includes("too_needy") || o.tags.includes("unnatural_intro")));
});

test("an edit that removes the money framing is read as a motivation correction", () => {
  const observations = observeEdit(
    "Media like this usually pays for itself in revenue within a couple of months.",
    "Media like this is what makes patients trust you before they ever call.",
  );
  assert.ok(observations.some((o) => /money framing/i.test(o.proposed_rule)));
  assert.ok(observations.some((o) => o.tags.includes("money_frame_wrong")));
});

test("a softened and a hardened CTA are told apart", () => {
  const softened = observeEdit(
    "Let's book a call with Avo on Monday.",
    "Worth a quick call with Avo at some point — no rush, only if it's useful.",
  );
  assert.ok(softened.some((o) => /softened/i.test(o.proposed_rule)));

  const hardened = observeEdit(
    "Happy to jump on a call with Avo whenever suits.",
    "Let's get a call with Avo booked in — does Tuesday work?",
  );
  assert.ok(hardened.some((o) => /more direct/i.test(o.proposed_rule)));
});

test("an edit that adds service clarity is read as the draft being vague", () => {
  const observations = observeEdit(
    "We could get your name in front of a lot more people.",
    "This is a paid service — we work with clients on the media and search presence behind their name.",
  );
  assert.ok(observations.some((o) => o.tags.includes("service_not_clear")));
});

test("a statement turned into a question is recorded", () => {
  const observations = observeEdit(
    "That's the gap most founders have before a raise.",
    "That's the gap most founders have before a raise — is that how you've been thinking about it?",
  );
  assert.ok(observations.some((o) => /statement into a question/i.test(o.proposed_rule)));
});

test("every proposal from an edit is inert until approved", () => {
  const observations = observeEdit(
    "Hey Sam — love your content, huge fan. Let's book a call with Avo. What are you building? What's the timeline?",
    "Hey Sam — what are you building toward this year?",
  );
  assert.ok(observations.length > 0);
  assert.ok(observations.every((o) => o.auto_apply === false));
  assert.ok(observations.every((o) => Array.isArray(o.tags)));
});
