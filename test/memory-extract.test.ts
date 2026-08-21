import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHumanCorrection, emptyMemory, makeItem, narrativeItem } from "@/core/memory";
import {
  buildExtractionInput,
  memoryPatchFromExtraction,
  transcriptFor,
  type ExtractedMemory,
} from "@/core/memory-extract";
import type { LeadMemory, Message } from "@/lib/types";

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
    extraction({
      relationship_summary: { value: "Rebuilding after a co-founder exit", quote: "my co-founder left in November" },
      communication_style: { value: "Direct, short replies", quote: "" },
    }),
    MESSAGES,
  );
  assert.match(patch.relationship_summary!.value, /co-founder/);
  assert.equal(patch.communication_style!.value, "Direct, short replies");

  const locked = { ...emptyMemory("l1"), verified_fields: ["relationship_summary"] };
  const second = memoryPatchFromExtraction(
    locked,
    "l1",
    extraction({ relationship_summary: { value: "Something else", quote: "" } }),
    MESSAGES,
  );
  assert.equal(second.patch.relationship_summary, undefined);
});

test("the transcript hands the model both sides in order", () => {
  const text = transcriptFor(MESSAGES);
  assert.match(text, /^Cassey: What are you focused on/);
  assert.match(text, /Prospect: Rebuilding the team/);
  assert.equal(text.split("\n").length, 4);
});

// ---------------------------------------------------------------------------
// The narrative fields are interpretations, not facts
// ---------------------------------------------------------------------------

test("an unsupported relationship summary stays an inference", () => {
  const { patch } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({ relationship_summary: { value: "Prospect trusts Cassey", quote: "" } }),
    MESSAGES,
  );

  const summary = patch.relationship_summary!;
  assert.equal(summary.provenance, "inference", "nothing in the conversation says this");
  assert.equal(summary.verified, false);
  assert.ok(summary.confidence < 0.5, `confidence should be low, was ${summary.confidence}`);
  assert.equal(summary.quote, null);
});

test("a supported summary is better evidenced but still an interpretation", () => {
  const { patch } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({
      relationship_summary: { value: "Carrying two roles since the co-founder left", quote: "my co-founder left in November" },
    }),
    MESSAGES,
  );

  const summary = patch.relationship_summary!;
  assert.equal(summary.provenance, "inference", "a reading of what they said is still a reading");
  assert.ok(summary.confidence > 0.5);
  assert.equal(summary.source_message_id, "m1");
});

test("a human-verified summary is never overwritten by extraction", () => {
  const corrected = applyHumanCorrection(emptyMemory("l1"), "l1", {
    relationship_summary: "Sceptical. Has been burned by an agency before.",
  });
  assert.equal(corrected.relationship_summary!.provenance, "human");
  assert.equal(corrected.relationship_summary!.verified, true);

  const memory = { ...emptyMemory("l1"), ...corrected } as LeadMemory;
  const { patch, stats } = memoryPatchFromExtraction(
    memory,
    "l1",
    extraction({ relationship_summary: { value: "Warm and enthusiastic", quote: "" } }),
    MESSAGES,
  );

  assert.equal(patch.relationship_summary, undefined, "the correction stands");
  assert.ok(stats.human_fields_skipped > 0);
});

test("a legacy plain-text summary reads as an unattributed inference", () => {
  const item = narrativeItem("Warm, replies quickly");
  assert.equal(item!.provenance, "inference");
  assert.equal(item!.verified, false);
  assert.equal(narrativeItem(null), null);
});

// ---------------------------------------------------------------------------
// Incremental extraction
// ---------------------------------------------------------------------------

test("the first run considers the whole conversation", () => {
  const input = buildExtractionInput(null, MESSAGES);

  assert.equal(input.skip, false);
  assert.equal(input.newMessages.length, MESSAGES.length);
  assert.match(input.alreadyKnown, /Nothing is remembered/);
  assert.equal(input.state.last_message_id, "m3");
  assert.equal(input.state.messages_considered, 4);
});

test("a later run only reads what is new, with a little context around it", () => {
  const memory: LeadMemory = {
    ...emptyMemory("l1"),
    businesses: [makeItem("SkyMD", "fact")],
    extraction_state: { last_message_id: "m1", last_message_at: null, messages_considered: 2, last_run_at: null },
  };

  const input = buildExtractionInput(memory, MESSAGES);
  assert.deepEqual(
    input.newMessages.map((m) => m.id),
    ["m2", "m3"],
  );
  assert.match(input.transcript, /Pushed it to March/, "the new messages are there");
  assert.match(input.transcript, /co-founder left/, "with enough of what came before to read them");
  assert.match(input.alreadyKnown, /SkyMD/, "and what is already remembered is listed");
  assert.equal(input.state.messages_considered, 4);
});

test("nothing new means no model call at all", () => {
  const memory: LeadMemory = {
    ...emptyMemory("l1"),
    extraction_state: { last_message_id: "m3", last_message_at: null, messages_considered: 4, last_run_at: null },
  };

  const input = buildExtractionInput(memory, MESSAGES);
  assert.equal(input.skip, true);
  assert.equal(input.newMessages.length, 0);
});

test("incremental extraction does not duplicate what is already remembered", () => {
  const memory: LeadMemory = {
    ...emptyMemory("l1"),
    businesses: [makeItem("SkyMD", "fact", { quote: "I run SkyMD" })],
    goals: [makeItem("Launch in March", "fact", { quote: "Pushed it to March" })],
    extraction_state: { last_message_id: "m1", last_message_at: null, messages_considered: 2, last_run_at: null },
  };

  const { patch, stats } = memoryPatchFromExtraction(
    memory,
    "l1",
    extraction({
      businesses: [{ value: "SkyMD", quote: "I run SkyMD" }],
      goals: [
        { value: "Launch in March", quote: "Pushed it to March" },
        { value: "Look serious before the launch", quote: "I want the brand to look serious before then" },
      ],
    }),
    MESSAGES,
  );

  assert.equal(patch.businesses!.length, 1, "SkyMD is remembered once");
  assert.equal(patch.goals!.length, 2, "only the genuinely new goal is added");
  assert.equal(stats.duplicates_ignored, 2);
  assert.equal(stats.proposed, 3);
  // "I run SkyMD" appears nowhere in these messages, so it stays an inference.
  assert.equal(stats.facts, 2);
  assert.equal(stats.inferences, 1);
});

test("the stats say what actually happened", () => {
  const { stats } = memoryPatchFromExtraction(
    null,
    "l1",
    extraction({
      businesses: [{ value: "SkyMD", quote: "I run SkyMD which is nowhere in the transcript" }],
      goals: [{ value: "Launch in March", quote: "Pushed it to March" }],
      relationship_summary: { value: "Under pressure", quote: "" },
    }),
    MESSAGES,
    { messagesConsidered: 2 },
  );

  assert.equal(stats.messages_considered, 2);
  assert.equal(stats.proposed, 3);
  assert.equal(stats.facts, 1, "the quote that was really there");
  assert.equal(stats.inferences, 2, "the invented quote, and the summary");
  assert.equal(stats.duplicates_ignored, 0);
});
