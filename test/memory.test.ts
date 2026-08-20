import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  applyExchangeToMemory,
  applyHumanCorrection,
  emptyMemory,
  extractQuestions,
  makeItem,
  mergeItem,
} from "@/core/memory";
import { LocalStore } from "@/lib/store/local-store";
import type { LeadMemory, Message, Strategy } from "@/lib/types";

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
  return { ...emptyMemory("lead-1"), ...overrides };
}

function prospect(text: string, id = ""): Pick<Message, "id" | "message_text" | "sent_at"> {
  return { id, message_text: text, sent_at: new Date().toISOString() };
}

function values(items: { value: string }[] | undefined): string[] {
  return (items ?? []).map((i) => i.value);
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
  assert.deepEqual(values(patch.questions_already_asked), ["What are you building toward this year?"]);
});

test("does not record the same question twice", () => {
  const existing = memoryWith({
    questions_already_asked: [makeItem("What are you building toward this year?", "fact")],
  });
  const patch = applyExchangeToMemory(existing, "lead-1", {
    strategy: strategyWith(),
    sentMessage: "what are you building toward this year?",
  });
  assert.equal(patch.questions_already_asked!.length, 1);
});

test("mergeItem keeps a human-verified entry rather than replacing it", () => {
  const human = makeItem("Runs Ledgerline and a second SaaS", "human", { verified: true });
  const merged = mergeItem([human], makeItem("runs ledgerline and a second saas", "inference", { confidence: 0.5 }));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].value, "Runs Ledgerline and a second SaaS");
  assert.equal(merged[0].verified, true);
});

test("explaining the service is recorded as an action, not as understanding", () => {
  const patch = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ should_explain_service: true }),
    sentMessage: "This is what we do for clients — we handle placement and positioning.",
    prospectMessages: [prospect("cool")],
  });

  assert.equal(patch.service_explained, true, "we explained it");
  assert.equal(patch.service_explained_count, 1);
  assert.equal(patch.service_understanding, 0, "a bare 'cool' does not establish understanding");
  assert.ok(values(patch.offers_explained).some((o) => /professional paid media/i.test(o)));
});

test("understanding rises only on the prospect's own commercial language", () => {
  const patch = applyExchangeToMemory(memoryWith({ service_explained: true }), "lead-1", {
    strategy: strategyWith(),
    sentMessage: "Happy to walk you through it.",
    prospectMessages: [prospect("so what would the pricing look like for something like that?")],
  });
  assert.equal(patch.service_understanding, 2);
});

test("fresh confusion resets understanding and is recorded as an objection", () => {
  const patch = applyExchangeToMemory(memoryWith({ service_explained: true, service_understanding: 2 }), "lead-1", {
    strategy: strategyWith(),
    sentMessage: "Worth a chat.",
    prospectMessages: [prospect("that makes sense, what does working with you look like"), prospect("wait, what show is this for?")],
  });
  assert.equal(patch.service_understanding, 0);
  assert.ok(values(patch.objections).some((o) => /podcast|guest|booking/i.test(o)));
});

test("records the Avo CTA only once the lead is call-ready", () => {
  const notReady = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ call_ready: false }),
    sentMessage: "What are you working toward?",
  });
  assert.deepEqual(values(notReady.ctas_already_used), []);

  const ready = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith({ call_ready: true }),
    sentMessage: "Worth 20 minutes with Avo this week?",
  });
  assert.deepEqual(values(ready.ctas_already_used), ["Offered a call with Avo"]);
});

test("captures buying signals and timing constraints from the prospect", () => {
  const patch = applyExchangeToMemory(memoryWith(), "lead-1", {
    strategy: strategyWith(),
    sentMessage: "Noted.",
    prospectMessages: [prospect("how much does this cost?"), prospect("we're launching in September")],
  });
  assert.ok(values(patch.buying_signals).some((b) => /price/i.test(b)));
  assert.ok(values(patch.timing_constraints).length > 0);
});

test("a human correction is marked verified and survives the next automatic update", async () => {
  const corrected = applyHumanCorrection(memoryWith(), "lead-1", {
    businesses: ["Ledgerline", "A second SaaS he did not mention"],
    service_understanding: 2,
  });
  assert.ok(corrected.verified_fields!.includes("businesses"));
  assert.ok(corrected.verified_fields!.includes("service_understanding"));

  const afterCorrection = memoryWith({ ...corrected } as Partial<LeadMemory>);

  // An automatic update that would normally lower understanding must not touch it.
  const auto = applyExchangeToMemory(afterCorrection, "lead-1", {
    strategy: strategyWith(),
    sentMessage: "Quick one.",
    prospectMessages: [prospect("cool")],
  });
  assert.equal(auto.service_understanding, undefined, "verified understanding is left alone");
  assert.equal(auto.businesses, undefined, "verified businesses are left alone");
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
  assert.deepEqual(values(created.questions_already_asked), ["What are you building toward?"]);
  assert.equal(created.current_strategy, "Establish the commercial goal");

  const merged = await store.upsertMemory(
    lead.id,
    applyExchangeToMemory(created, lead.id, {
      strategy: strategyWith({ should_explain_service: true }),
      sentMessage: "And what comes up when people search you?",
    }),
  );
  assert.deepEqual(values(merged.questions_already_asked), [
    "What are you building toward?",
    "And what comes up when people search you?",
  ]);
  assert.equal(merged.service_explained, true);

  assert.equal((await store.getMemory(lead.id))!.service_explained, true);
});
