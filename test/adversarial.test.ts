import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSetterForLead, type AgentDeps } from "@/core/agent";
import { evaluateGate } from "@/core/gate";
import { applyExchangeToMemory, applyHumanCorrection, emptyMemory } from "@/core/memory";
import { offlineLlm } from "@/core/offline-llm";
import { rerankAndBucket } from "@/core/retrieval";
import { LocalStore } from "@/lib/store/local-store";
import type { ConversationChunk, Lead, Qualification, Strategy } from "@/lib/types";

/**
 * Adversarial checks: each test states a way the system could plausibly be
 * subverted, and asserts that it cannot be.
 */

async function freshDeps(): Promise<AgentDeps> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-adv-"));
  return { store: new LocalStore(dir), llm: offlineLlm, voiceSetter: "Cassey" };
}

function strategyWith(q: Partial<Qualification> = {}, over: Partial<Strategy> = {}): Strategy {
  const qualification: Qualification = {
    fit: 2, commercial_goal: 2, media_gap: 2, value_established: 2, service_understanding: 2, interest_signal: 2, ...q,
  };
  return {
    stage: "CALL_READY", qualification,
    total_score: Object.values(qualification).reduce((a, b) => a + b, 0),
    call_ready: true, service_confusion: false, confusion_reason: null,
    next_objective: "book", strategy: "", missing_information: [],
    credibility_needed: false, credibility_reason: null, should_explain_service: false, ...over,
  };
}

test("a model cannot open the gate by inflating total_score alone", () => {
  // The model reports a perfect total while a dimension is plainly zero.
  const lying = strategyWith({ media_gap: 0 }, { total_score: 12, call_ready: true });
  const gate = evaluateGate(lying);
  assert.equal(gate.passed, false, "the gate recomputes the total from the dimensions");
  assert.equal(gate.total_score, 10, "the reported total is ignored");
});

test("a model cannot book by claiming the prospect understands when they never said so", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "advlead", industry: "Fintech", niche: "payments" });
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "we help clients with media and authority" },
    { sender: "prospect", message_text: "cool" },
  ]);

  const overconfident = { ...offlineLlm, async strategy() { return strategyWith(); } };
  const result = await runSetterForLead(lead.id, "cool", { ...deps, llm: overconfident });

  assert.equal(result.strategy.qualification.service_understanding, 0, "'cool' is not understanding");
  assert.equal(result.gate.passed, false);
});

test("a prospect who becomes confused late cannot remain call-ready", async () => {
  const deps = await freshDeps();
  const mara = (await deps.store.getLeadByHandle("marasellsdesign"))!;

  const before = await runSetterForLead(mara.id, "sounds good", deps);
  assert.equal(before.gate.passed, true);

  await deps.store.appendMessages(mara.id, [
    { sender: "prospect", message_text: "hold on, is this a collaboration or are you inviting me on a podcast?" },
  ]);
  const after = await runSetterForLead(mara.id, "is this a collab?", deps);
  assert.equal(after.gate.passed, false);
  assert.equal(after.strategy.qualification.service_understanding, 0);
});

test("a No Show example can never be presented as a winner or a voice reference", () => {
  const chunk = (over: Partial<ConversationChunk>): ConversationChunk => ({
    id: Math.random().toString(36).slice(2), source_conversation_id: null, outcome: "⚫ No show",
    outcome_tier: "E", stage: null, niche: null, industry: null, setter_name: "Cassey",
    content: "a losing approach", metadata: {}, quality_score: 5, similarity: 0.99, ...over,
  });

  const lead = { id: "l", instagram_handle: "x", industry: null, niche: null, media_experience: null } as unknown as Lead;
  const buckets = rerankAndBucket([chunk({}), chunk({})], { lead, strategy: strategyWith(), voiceSetter: "Cassey" });

  assert.equal(buckets.strong_winners.length, 0, "a no-show is never a winner");
  assert.equal(buckets.partial_wins.length, 0);
  assert.equal(buckets.voice_examples.length, 0, "and never a phrasing template, even in Cassey's voice");
  assert.equal(buckets.failures.length, 2, "it is surfaced, but only as a warning");
});

test("a chunk cannot appear in two buckets at once", () => {
  const shared: ConversationChunk = {
    id: "same-id", source_conversation_id: null, outcome: "📞 Onboarding Call", outcome_tier: "A",
    stage: null, niche: null, industry: null, setter_name: "Cassey", content: "x", metadata: {},
    quality_score: null, similarity: 0.5,
  };
  const lead = { id: "l", instagram_handle: "x", industry: null, niche: null, media_experience: null } as unknown as Lead;
  const buckets = rerankAndBucket([shared, { ...shared }], { lead, strategy: strategyWith() });
  const ids = [...buckets.strong_winners, ...buckets.partial_wins, ...buckets.failures].map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicates across buckets");
});

test("an automatic update cannot overwrite a human correction, even with contradicting evidence", () => {
  const corrected = applyHumanCorrection(emptyMemory("l1"), "l1", {
    businesses: ["SkyMD", "FitProtection"],
    service_understanding: 2,
  });
  const memory = { ...emptyMemory("l1"), ...corrected };

  // The prospect now says something that would normally reset understanding to 0.
  const auto = applyExchangeToMemory(memory, "l1", {
    strategy: strategyWith({}, { service_confusion: true }),
    sentMessage: "quick one",
    prospectMessages: [{ id: "m", message_text: "how long is the pod?", sent_at: new Date().toISOString() }],
  });

  assert.equal(auto.service_understanding, undefined, "verified understanding is not touched");
  assert.equal(auto.businesses, undefined, "verified businesses are not touched");
});

test("a verified transcript is not clobbered by re-running ingestion", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-adv-corpus-"));
  const store = new LocalStore(dir);

  await store.upsertSourceConversation({ external_card_id: "card1", transcript: "draft", status: "needs_review" });
  await store.upsertSourceConversation({ external_card_id: "card1", transcript: "human approved text", status: "verified" });

  // Re-ingestion tries to replace it with a fresh machine draft.
  const after = await store.upsertSourceConversation({
    external_card_id: "card1",
    transcript: "MACHINE RE-INGEST",
    status: "pending_ocr",
  });

  assert.equal(after.transcript, "human approved text", "the verified transcript survives");
  assert.equal(after.status, "verified");

  // But a human may still correct their own verified transcript.
  const edited = await store.updateSourceConversation(after.id, { transcript: "human second pass" });
  assert.equal(edited.transcript, "human second pass");
});

test("re-running ingestion does not duplicate conversations or chunks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-adv-dupe-"));
  const store = new LocalStore(dir);

  for (let i = 0; i < 3; i += 1) {
    await store.upsertSourceConversation({ external_card_id: "cardX", instagram_handle: "someone" });
  }
  assert.equal((await store.listSourceConversations()).length, 1, "keyed on the Trello card id");

  const conv = (await store.listSourceConversations())[0];
  const chunk = {
    source_conversation_id: conv.id, outcome: "x", outcome_tier: "A" as const, stage: null,
    niche: null, industry: null, setter_name: null, content: "distinctive chunk content about authority building", metadata: {}, quality_score: null,
  };
  await store.replaceChunksForConversation(conv.id, [chunk, chunk]);
  await store.replaceChunksForConversation(conv.id, [chunk, chunk]);

  // The seeded demo corpus also matches, so count only this conversation's chunks.
  const found = (await store.matchChunks("distinctive chunk content authority", 50)).filter(
    (c) => c.source_conversation_id === conv.id,
  );
  assert.equal(found.length, 2, "chunks are replaced, never appended");
});

test("the writer is told to cite nothing when no credibility is relevant", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "nocred", industry: "Aerospace", niche: "satellites" });
  const result = await runSetterForLead(lead.id, "tell me more", deps);

  assert.equal(result.credibility_used.length, 0, "the placeholder asset does not match aerospace");
  const { compactContext, loadLeadContext } = await import("@/core/context");
  const ctx = await loadLeadContext(deps.store, lead.id, "tell me more");
  assert.match(compactContext(ctx), /never invent a client, outlet, metric or result/i);
});

test("an unqualified lead cannot reach a call however many times we regenerate", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "persistent" });

  for (let i = 0; i < 3; i += 1) {
    const result = await runSetterForLead(lead.id, "sure sounds good", deps);
    assert.equal(result.gate.passed, false, `attempt ${i + 1} must stay blocked`);
    assert.doesNotMatch(result.reviewer.final_reply, /\bAvo\b/, "no CTA while unqualified");
  }
});
