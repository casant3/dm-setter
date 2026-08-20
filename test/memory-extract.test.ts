import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMemory, makeItem } from "@/core/memory";
import { memoryPatchFromExtraction, transcriptFor, type ExtractedMemory } from "@/core/memory-extract";
import type { Message } from "@/lib/types";

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

const MESSAGES = [
  msg("setter", "What are you focused on this year?", 0),
  msg("prospect", "Rebuilding the team honestly — my co-founder left in November and I've been covering both roles", 1),
  msg("setter", "That's a lot. What does that mean for the launch?", 2),
  msg("prospect", "Pushed it to March. I want the brand to look serious before then", 3),
];

function extraction(overrides: Partial<ExtractedMemory> = {}): ExtractedMemory {
  return {
    relationship_summary: null,
    communication_style: null,
    businesses: [],
    goals: [],
    personal_goals: [],
    facts_known: [],
    pain_points: [],
    interests: [],
    media_history: [],
    opportunities_identified: [],
    key_entities: [],
    objections: [],
    followup_commitments: [],
    ...overrides,
  };
}

test("an item whose quote is in the conversation is recorded as a fact", () => {
  const { patch, stats } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({
      pain_points: [{ value: "Co-founder left in November; covering both roles", quote: "my co-founder left in November" }],
    }),
    MESSAGES,
  );
  assert.equal(stats.facts, 1);
  assert.equal(stats.inferences, 0);
  const item = patch.pain_points![0];
  assert.equal(item.provenance, "fact");
  assert.equal(item.source_message_id, "m1");
  assert.ok(item.confidence >= 0.9);
});

test("an item whose quote is not in the conversation is kept only as a weak inference", () => {
  const { patch, stats } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({
      goals: [{ value: "Raising a Series A", quote: "we're raising a Series A in the spring" }],
    }),
    MESSAGES,
  );
  assert.equal(stats.facts, 0);
  assert.equal(stats.inferences, 1);
  const item = patch.goals![0];
  assert.equal(item.provenance, "inference");
  assert.ok(item.confidence <= 0.5, "an unverifiable claim never enters memory at full confidence");
});

test("fields a human has verified are left alone entirely", () => {
  const memory = {
    ...emptyMemory("l1"),
    goals: [makeItem("Launch in March", "human", { verified: true, confidence: 1 })],
    verified_fields: ["goals"],
  };
  const { patch } = memoryPatchFromExtraction(
    memory,
    "l1",
    extraction({ goals: [{ value: "Something else entirely", quote: "Pushed it to March" }] }),
    MESSAGES,
  );
  assert.equal(patch.goals, undefined, "a human correction is the end of the argument");
});

test("extraction merges with what is already known rather than replacing it", () => {
  const memory = { ...emptyMemory("l1"), businesses: [makeItem("SkyMD", "fact", { confidence: 1 })] };
  const { patch } = memoryPatchFromExtraction(
    memory,
    "l1",
    extraction({ businesses: [{ value: "FitProtection", quote: "my co-founder left in November" }] }),
    MESSAGES,
  );
  assert.equal(patch.businesses!.length, 2);
  assert.ok(patch.businesses!.some((b) => b.value === "SkyMD"));
});

test("empty lists produce no patch fields at all", () => {
  const { patch } = memoryPatchFromExtraction(null, "l1", extraction(), MESSAGES);
  assert.deepEqual(Object.keys(patch).sort(), ["lead_id", "updated_at"]);
});

test("the summary and style are taken, unless a human has set them", () => {
  const { patch } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({ relationship_summary: "Rebuilding after a co-founder exit", communication_style: "Direct, short replies" }),
    MESSAGES,
  );
  assert.match(patch.relationship_summary!, /co-founder/);
  assert.equal(patch.communication_style, "Direct, short replies");

  const locked = { ...emptyMemory("l1"), verified_fields: ["relationship_summary"] };
  const second = memoryPatchFromExtraction(locked, "l1", extraction({ relationship_summary: "Something else" }), MESSAGES);
  assert.equal(second.patch.relationship_summary, undefined);
});

test("the transcript hands the model both sides in order", () => {
  const text = transcriptFor(MESSAGES);
  assert.match(text, /^Cassey: What are you focused on/);
  assert.match(text, /Prospect: Rebuilding the team/);
  assert.equal(text.split("\n").length, 4);
});
