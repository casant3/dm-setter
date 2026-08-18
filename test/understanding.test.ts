import assert from "node:assert/strict";
import { test } from "node:test";
import { assessUnderstanding, detectConfusion } from "@/core/understanding";
import type { Message } from "@/lib/types";

function msgs(...texts: string[]): Pick<Message, "id" | "message_text" | "sent_at">[] {
  return texts.map((t, i) => ({ id: `m${i}`, message_text: t, sent_at: new Date(2026, 0, i + 1).toISOString() }));
}

test("explaining the service does not by itself establish understanding", () => {
  const explained = assessUnderstanding(msgs("cool"), true);
  assert.equal(explained.level, 0, "a bare acknowledgement proves nothing");
  assert.equal(explained.evidence[0].strength, "weak");
});

test("weak acknowledgements are all treated as weak", () => {
  for (const ack of ["cool", "sure", "sounds good", "ok", "great", "interesting", "yeah"]) {
    const a = assessUnderstanding(msgs(ack), true);
    assert.equal(a.level, 0, `"${ack}" must not raise understanding`);
  }
});

test("commercial questions are strong evidence of understanding", () => {
  for (const text of [
    "how much does this cost?",
    "what's your pricing like?",
    "what does working with you look like?",
    "so you help clients with this?",
    "what's the process?",
  ]) {
    const a = assessUnderstanding(msgs(text), true);
    assert.equal(a.level, 2, `"${text}" should be strong evidence`);
    assert.equal(a.evidence.at(-1)?.strength, "strong");
  }
});

test("engaging with the mechanism is strong evidence", () => {
  const a = assessUnderstanding(msgs("the written media and search presence side is what I'd actually need"), true);
  assert.equal(a.level, 2);
});

test("partial engagement with the value scores 1, not 2", () => {
  const a = assessUnderstanding(msgs("yeah credibility is something I've thought about"), true);
  assert.equal(a.level, 1);
  assert.equal(a.evidence[0].strength, "moderate");
});

test("understanding is evidenced even when we never explained anything", () => {
  const a = assessUnderstanding(msgs("what would your pricing be for that?"), false);
  assert.equal(a.level, 2, "their own words are what count, not our explanation");
});

test("confusion collapses understanding no matter how well they engaged earlier", () => {
  const a = assessUnderstanding(
    msgs("what does working with you look like?", "how long is the pod though?"),
    true,
  );
  assert.equal(a.level, 0, "later confusion overrides earlier understanding");
  assert.ok(a.confusion);
  assert.match(a.confusion!.reason, /podcast episode/i);
});

test("understanding recovers once confusion is no longer present", () => {
  const a = assessUnderstanding(msgs("how long is the pod?", "ah got it — so what's the pricing?"), true);
  assert.equal(a.level, 2);
  assert.equal(a.confusion, null);
});

test("every documented confusion phrase is detected", () => {
  const phrases = [
    "How long is the pod?",
    "What podcast is this for?",
    "Is this a collaboration?",
    "I don't pay to go on podcasts.",
    "Are you inviting me on?",
    "Is this free?",
    "Is there a cost?",
  ];
  for (const p of phrases) {
    assert.ok(detectConfusion(p) !== null, `should flag: ${p}`);
  }
});

test("ordinary sales conversation is not mistaken for confusion", () => {
  for (const text of [
    "raising a Series A in Q1",
    "honestly not much comes up when people search me",
    "what would this look like for my launch?",
    "I've done a few podcasts before but nothing written",
  ]) {
    assert.equal(detectConfusion(text), null, `should not flag: ${text}`);
  }
});

test("evidence carries the quote and message id so it can be traced", () => {
  const a = assessUnderstanding(msgs("what's the pricing on that?"), true);
  assert.equal(a.evidence[0].message_id, "m0");
  assert.match(a.evidence[0].quote, /pricing/);
  assert.ok(a.evidence[0].reason.length > 0);
});
