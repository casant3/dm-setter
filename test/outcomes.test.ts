import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIST_DISCOVERY,
  LIST_FOLLOWUP,
  LIST_NOT_INTERESTED,
  LIST_NO_SHOW,
  LIST_NURTURING,
  LIST_ONBOARDING,
  TIER_WEIGHT,
  assessOutcome,
  promoteWithSignals,
} from "@/core/outcomes";
import { rerankAndBucket, scoreChunk } from "@/core/retrieval";
import type { ConversationChunk, Lead, Strategy } from "@/lib/types";

test("onboarding is the strongest tier", () => {
  const a = assessOutcome(LIST_ONBOARDING, []);
  assert.equal(a.tier, "A");
  assert.equal(a.evidence_class, "strong_winner");
});

test("a booked discovery with no downstream result is NOT a winner", () => {
  const a = assessOutcome(LIST_DISCOVERY, []);
  assert.equal(a.tier, "C");
  assert.equal(a.evidence_class, "neutral");
  assert.match(a.rationale, /not treated as a win/i);
});

test("a discovery that later became not-interested is negative evidence", () => {
  const a = assessOutcome(LIST_NOT_INTERESTED, [
    { from: LIST_DISCOVERY, to: LIST_NOT_INTERESTED, at: "2026-08-01T00:00:00Z" },
  ]);
  assert.equal(a.tier, "F");
  assert.equal(a.evidence_class, "failure");
  assert.equal(a.booking_not_honoured, true, "the booking did not reflect real interest");
});

test("a discovery that no-showed is negative evidence", () => {
  const a = assessOutcome(LIST_NO_SHOW, [{ from: LIST_DISCOVERY, to: LIST_NO_SHOW, at: "2026-08-01T00:00:00Z" }]);
  assert.equal(a.tier, "E");
  assert.equal(a.booking_not_honoured, true);
});

test("a discovery that slid back to follow-up is not a win", () => {
  const a = assessOutcome(LIST_FOLLOWUP, [{ from: LIST_DISCOVERY, to: LIST_FOLLOWUP, at: "2026-08-17T00:00:00Z" }]);
  assert.equal(a.tier, "D");
  assert.equal(a.booking_not_honoured, true);
  assert.match(a.rationale, /did not hold/i);
});

test("nurturing that progressed to onboarding is tier A", () => {
  const a = assessOutcome(LIST_ONBOARDING, [
    { from: LIST_NURTURING, to: LIST_ONBOARDING, at: "2026-08-14T00:00:00Z" },
  ]);
  assert.equal(a.tier, "A");
});

test("a discovery is promoted to B only when there is evidence it happened", () => {
  const base = assessOutcome(LIST_DISCOVERY, []);
  assert.equal(promoteWithSignals(base, {}).tier, "C", "no signal, no promotion");
  assert.equal(promoteWithSignals(base, { showed: true }).tier, "B");
  assert.equal(promoteWithSignals(base, { closed: true }).tier, "A");
});

test("strong outcomes outrank a raw discovery booking in retrieval", () => {
  assert.ok(TIER_WEIGHT.A > TIER_WEIGHT.C, "onboarding must outrank a bare booking");
  assert.ok(TIER_WEIGHT.B > TIER_WEIGHT.C);
  assert.ok(TIER_WEIGHT.F > TIER_WEIGHT.C, "failures are retrieved deliberately as counter-examples");
});

// ---------------------------------------------------------------------------

const lead: Lead = {
  id: "l1",
  instagram_handle: "founder",
  name: "A Founder",
  company: null,
  job_title: null,
  industry: "Fintech",
  niche: "SMB accounting software",
  followers: null,
  location: null,
  lead_status: null,
  interest_level: null,
  conversation_stage: null,
  priority: null,
  media_experience: null,
  authority_level: null,
  media_gap: null,
  commercial_goal: null,
  first_contact_at: null,
  last_contact_at: null,
  next_followup_at: null,
  followup_status: null,
  followup_note: null,
  booked_call: null,
  booked_call_at: null,
  outcome: null,
  created_at: null,
  updated_at: null,
};

const strategy: Strategy = {
  stage: "VALUE_BUILDING",
  qualification: { fit: 2, commercial_goal: 2, media_gap: 1, value_established: 1, service_understanding: 1, interest_signal: 1 },
  total_score: 8,
  call_ready: false,
  service_confusion: false,
  confusion_reason: null,
  next_objective: "Link media to the raise",
  strategy: "",
  missing_information: [],
  credibility_needed: false,
  credibility_reason: null,
  should_explain_service: false,
};

function chunk(over: Partial<ConversationChunk>): ConversationChunk {
  return {
    id: Math.random().toString(36).slice(2),
    source_conversation_id: null,
    outcome: null,
    outcome_tier: "C",
    stage: null,
    niche: null,
    industry: null,
    setter_name: null,
    content: "example",
    metadata: {},
    quality_score: null,
    similarity: 0.5,
    ...over,
  };
}

test("an onboarding example outranks an identical discovery-only example", () => {
  const onboarding = chunk({ outcome_tier: "A", similarity: 0.5 });
  const discovery = chunk({ outcome_tier: "C", similarity: 0.5 });
  const a = scoreChunk(onboarding, { lead, strategy }).score;
  const b = scoreChunk(discovery, { lead, strategy }).score;
  assert.ok(a > b, `tier A (${a}) should outrank tier C (${b})`);
});

test("reranking labels the three buckets and never mixes them", () => {
  const buckets = rerankAndBucket(
    [
      chunk({ outcome_tier: "A", content: "won", similarity: 0.4 }),
      chunk({ outcome_tier: "B", content: "partial", similarity: 0.4 }),
      chunk({ outcome_tier: "F", content: "lost", similarity: 0.9 }),
      chunk({ outcome_tier: "E", content: "no showed", similarity: 0.8 }),
    ],
    { lead, strategy },
  );
  assert.equal(buckets.strong_winners.length, 1);
  assert.equal(buckets.strong_winners[0].content, "won");
  assert.equal(buckets.partial_wins[0].content, "partial");
  assert.equal(buckets.failures.length, 2, "both negative outcomes are surfaced as counter-examples");
  assert.ok(buckets.failures.every((f) => f.evidence_class === "failure"));
});

test("failures are retrieved even when they are the most similar examples", () => {
  const buckets = rerankAndBucket(
    [chunk({ outcome_tier: "F", content: "very similar failure", similarity: 0.99 })],
    { lead, strategy },
  );
  assert.equal(buckets.strong_winners.length, 0);
  assert.equal(buckets.failures.length, 1, "a highly similar failure must still be shown, as a warning");
});

test("Cassey's voice examples are separated from team strategy examples", () => {
  const buckets = rerankAndBucket(
    [
      chunk({ outcome_tier: "A", setter_name: "William", content: "William's winning approach", similarity: 0.9 }),
      chunk({ outcome_tier: "A", setter_name: "Cassey", content: "Cassey's phrasing", similarity: 0.3 }),
    ],
    { lead, strategy, voiceSetter: "Cassey" },
  );

  // William's stronger example is still available as strategy evidence...
  assert.ok(buckets.strong_winners.some((c) => c.setter_name === "William"));
  // ...but voice comes only from Cassey, despite the lower similarity.
  assert.equal(buckets.voice_examples.length, 1);
  assert.equal(buckets.voice_examples[0].setter_name, "Cassey");
});

test("a failure is never offered as a voice example", () => {
  const buckets = rerankAndBucket(
    [chunk({ outcome_tier: "F", setter_name: "Cassey", content: "a losing message", similarity: 0.9 })],
    { lead, strategy, voiceSetter: "Cassey" },
  );
  assert.equal(buckets.voice_examples.length, 0, "we do not imitate the phrasing of a loss");
});

test("service-confusion examples are boosted when the lead is confused", () => {
  const confusedStrategy = { ...strategy, service_confusion: true };
  const relevant = chunk({ outcome_tier: "A", metadata: { service_confusion: true } });
  const plain = chunk({ outcome_tier: "A", metadata: { service_confusion: false } });
  const a = scoreChunk(relevant, { lead, strategy: confusedStrategy }).score;
  const b = scoreChunk(plain, { lead, strategy: confusedStrategy }).score;
  assert.ok(a > b);
});

test("same-niche examples rank above unrelated ones", () => {
  const same = chunk({ niche: "SMB accounting software" });
  const other = chunk({ niche: "wedding photography" });
  const a = scoreChunk(same, { lead, strategy });
  const b = scoreChunk(other, { lead, strategy });
  assert.ok(a.score > b.score);
  assert.ok(a.reasons.includes("same niche"));
});
