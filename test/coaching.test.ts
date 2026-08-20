import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSetterForLead, type AgentDeps } from "@/core/agent";
import { buildCoachingLayer, observeEdit, parseChatGptExport } from "@/core/coaching";
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
    situation: "They say they are open to opportunities",
    prospect_message: "always open to opportunities",
    approved_reply: "Good to know. What are you actually building toward this year?",
    why: "Convert the openness into something concrete",
    source: "human",
    status: "approved",
    tags: [],
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

const EXPORT = [
  {
    title: "DM reply for a founder lead",
    mapping: {
      a: { message: { author: { role: "user" }, content: { parts: ["How should I reply to this prospect DM?"] } } },
      b: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Makes sense — what are you actually building toward this year? Happy to keep it short."] },
        },
      },
      c: {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Hi"] },
        },
      },
    },
  },
  {
    title: "Recipe ideas",
    mapping: {
      a: { message: { author: { role: "user" }, content: { parts: ["what can I cook tonight"] } } },
      b: { message: { author: { role: "assistant" }, content: { parts: ["You could make a risotto with whatever is in the fridge tonight."] } } },
    },
  },
];

test("the importer finds DM-like replies and ignores unrelated conversations", () => {
  const candidates = parseChatGptExport(EXPORT);
  assert.equal(candidates.length, 1, "the recipe chat and the one-word reply are both skipped");
  assert.match(candidates[0].approved_reply, /building toward/);
  assert.equal(candidates[0].situation, "DM reply for a founder lead");
  assert.match(candidates[0].prospect_message ?? "", /How should I reply/);
});

test("nothing imported is treated as approved", async () => {
  const deps = await freshDeps();
  for (const candidate of parseChatGptExport(EXPORT)) {
    await deps.store.createCoachingExample({
      setter_name: "Cassey",
      situation: candidate.situation,
      prospect_message: candidate.prospect_message,
      approved_reply: candidate.approved_reply,
      why: null,
      source: "chatgpt_import",
      status: "pending_review",
      tags: ["imported"],
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
