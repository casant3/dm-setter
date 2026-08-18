import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyExchangeToMemory, extractQuestions } from "@/core/memory";
import { LocalStore } from "@/lib/store/local-store";
import type { LeadMemory, Strategy } from "@/lib/types";

function strategyWith(overrides: Partial<Strategy> = {}): Strategy {
  return {
    stage: "DISCOVERY",
    qualification: {
      fit: 2,
      commercial_goal: 1,
      media_gap: 1,
      value_established: 1,
      service_understanding: 1,
      interest_signal: 1,
    },
    total_score: 7,
    call_ready: false,
    service_confusion: false,
    confusion_reason: null,
    next_objective: "Establish the commercial goal",
    strategy: "Ask one specific question",
    missing_information: [],
    credibility_needed: false,
    credibility_reason: null,
    should_explain_service: false,
    ...overrides,
  };
}

function memoryWith(overrides: Partial<LeadMemory> = {}): LeadMemory {
  return {
    lead_id: "lead-1",
    relationship_summary: null,
    facts_known: [],
    businesses: [],
    goals: [],
    pain_points: [],
    interests: [],
    objections: [],
    media_history: [],
    opportunities_identified: [],
    questions_already_asked: [],
    offers_explained: [],
    ctas_already_used: [],
    communication_style: null,
    current_strategy: null,
    service_understanding: 0,
    updated_at: null,
    ...overrides,
  };
}

test("pulls the questions out of a sent DM", () => {
  const questions = extractQuestions(
    "That makes sense. What are you building toward this year? Also, what comes up when people search you?",
  );
  assert.deepEqual(questions, [
    "What are you building toward this year?",
    "Also, what comes up when people search you?",
  ]);
});

test("ignores statements and stray question marks", () => {
  assert.deepEqual(extractQuestions("Sounds good, talk soon."), []);
  assert.deepEqual(extractQuestions("ok?"), []);
});

test("records asked questions so they are never repeated", () => {
  const patch = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith(),
    sentMessage: "What are you building toward this year?",
  });
  assert.deepEqual(patch.questions_already_asked, ["What are you building toward this year?"]);
});

test("does not record the same question twice", () => {
  const patch = applyExchangeToMemory(
    memoryWith({ questions_already_asked: ["What are you building toward this year?"] }),
    "lead-1",
    { strategy: strategyWith(), sentMessage: "what are you building toward this year?" },
  );
  assert.equal(patch.questions_already_asked!.length, 1);
});

test("records that the service was explained and raises understanding", () => {
  const patch = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ should_explain_service: true }),
    sentMessage: "This is what we do for clients — we handle placement and positioning.",
  });
  assert.ok(patch.offers_explained!.some((o) => /paid professional/i.test(String(o))));
  assert.equal(patch.service_understanding, 1);
});

test("understanding never regresses on its own", () => {
  const patch = applyExchangeToMemory(memoryWith({ service_understanding: 2 }), "lead-1", {
    strategy: strategyWith(),
    sentMessage: "Sounds good.",
  });
  assert.equal(patch.service_understanding, 2);
});

test("fresh confusion resets understanding, which re-opens the gate", () => {
  const patch = applyExchangeToMemory(memoryWith({ service_understanding: 2 }), "lead-1", {
    strategy: strategyWith({ service_confusion: true, confusion_reason: "Asked what show this is for" }),
    sentMessage: "Ah, I should be clearer — this isn't a guest invitation.",
    prospectMessage: "what show is this for?",
  });
  assert.equal(patch.service_understanding, 0);
  assert.ok(patch.objections!.includes("Asked what show this is for"));
});

test("records the Avo CTA only once the lead is call-ready", () => {
  const notReady = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ call_ready: false }),
    sentMessage: "What are you working toward?",
  });
  assert.deepEqual(notReady.ctas_already_used, []);

  const ready = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ call_ready: true }),
    sentMessage: "Worth 20 minutes with Avo this week?",
  });
  assert.deepEqual(ready.ctas_already_used, ["Offered a call with Avo"]);
});

test("the store creates memory when a lead has none, then merges into it", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-memory-"));
  const store = new LocalStore(dir);
  const lead = await store.createLead({ instagram_handle: "freshlead" });

  assert.equal(await store.getMemory(lead.id), null);

  const created = await store.upsertMemory(
    lead.id,
    applyExchangeToMemory(null, lead.id, {
      strategy: strategyWith(),
      sentMessage: "What are you building toward?",
    }),
  );
  assert.deepEqual(created.questions_already_asked, ["What are you building toward?"]);
  assert.equal(created.current_strategy, "Establish the commercial goal");

  const merged = await store.upsertMemory(
    lead.id,
    applyExchangeToMemory(created, lead.id, {
      strategy: strategyWith({ should_explain_service: true }),
      sentMessage: "And what comes up when people search you?",
    }),
  );
  assert.deepEqual(merged.questions_already_asked, [
    "What are you building toward?",
    "And what comes up when people search you?",
  ]);
  assert.equal(merged.service_understanding, 1);

  // The merge must persist, not just mutate the in-memory copy.
  assert.equal((await store.getMemory(lead.id))!.service_understanding, 1);
});
