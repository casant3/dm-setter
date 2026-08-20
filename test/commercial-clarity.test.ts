import assert from "node:assert/strict";
import { test } from "node:test";
import { assessUnderstanding, classifyCostQuestion, detectConfusion } from "@/core/understanding";
import type { Message } from "@/lib/types";

function msgs(...texts: string[]): Pick<Message, "id" | "message_text" | "sent_at">[] {
  return texts.map((t, i) => ({ id: `m${i}`, message_text: t, sent_at: new Date(2026, 0, i + 1).toISOString() }));
}

// ---------------------------------------------------------------------------
// Explicit pricing questions are buying signals, never podcast confusion
// ---------------------------------------------------------------------------

test("explicit pricing questions are commercial, not confusion", () => {
  for (const text of [
    "How much do you guys charge?",
    "What do you charge?",
    "what does it cost?",
    "What are the packages?",
    "What does working with you look like?",
    "what would this involve?",
    "can you give me a ballpark?",
    "what's the price range?",
  ]) {
    assert.equal(detectConfusion(text), null, `"${text}" must not be service confusion`);
    assert.equal(classifyCostQuestion(text).kind, "commercial_question", `"${text}" should be a commercial question`);
  }
});

test("a pricing question scores full understanding without any explanation from us", () => {
  const a = assessUnderstanding(msgs("How much do you guys charge?"), false);
  assert.equal(a.level, 2);
  assert.equal(a.confusion, null);
  assert.equal(a.commercial_clarity_needed, null);
  assert.equal(a.evidence[0].strength, "strong");
});

// ---------------------------------------------------------------------------
// Genuine service confusion still closes the gate
// ---------------------------------------------------------------------------

test("podcast-framing questions remain service confusion", () => {
  for (const text of [
    "How long is the podcast?",
    "What show is this for?",
    "Are you inviting me on?",
    "I don't pay to go on podcasts.",
    "Is this a free collab?",
    "Why would I pay to be a guest?",
  ]) {
    assert.ok(detectConfusion(text) !== null, `"${text}" must still be service confusion`);
  }
});

test("service confusion zeroes understanding regardless of explanation", () => {
  const a = assessUnderstanding(msgs("How long is the pod?"), true);
  assert.equal(a.level, 0);
  assert.ok(a.confusion);
  assert.equal(a.commercial_clarity_needed, null);
});

// ---------------------------------------------------------------------------
// Ambiguous cost questions resolve against context
// ---------------------------------------------------------------------------

test("'is there a cost?' is ambiguous on its own", () => {
  assert.equal(classifyCostQuestion("Is there a cost?").kind, "ambiguous_cost");
  assert.equal(detectConfusion("Is there a cost?"), null, "no longer hard-coded as podcast confusion");
});

test("'is there a cost?' AFTER the service was explained is a buying question", () => {
  const a = assessUnderstanding(msgs("Is there a cost?"), true);
  assert.equal(a.level, 2, "they know it is a service and are asking the price");
  assert.equal(a.confusion, null);
  assert.equal(a.commercial_clarity_needed, null);
  assert.match(a.evidence[0].reason, /buying question/i);
});

test("'is there a cost?' BEFORE any explanation needs commercial clarity, not a premise correction", () => {
  const a = assessUnderstanding(msgs("Is there a cost?"), false);
  assert.equal(a.confusion, null, "this is not podcast confusion");
  assert.ok(a.commercial_clarity_needed, "but the commercial model was never made clear");
  assert.ok(a.level <= 1, "understanding is capped, not zeroed");
});

test("'is this free?' before explanation is commercial clarity, after is a buying question", () => {
  assert.ok(assessUnderstanding(msgs("is this free?"), false).commercial_clarity_needed);
  assert.equal(assessUnderstanding(msgs("is this free?"), true).level, 2);
});

test("commercial clarity is cleared once they engage commercially afterwards", () => {
  const a = assessUnderstanding(msgs("is there a cost?", "ah got it — what do you charge?"), false);
  assert.equal(a.commercial_clarity_needed, null);
  assert.equal(a.level, 2);
});

test("weak acknowledgement still proves nothing", () => {
  const a = assessUnderstanding(msgs("Sounds good"), true);
  assert.equal(a.level, 0);
  assert.equal(a.confusion, null);
  assert.equal(a.commercial_clarity_needed, null);
});
