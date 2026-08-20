import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_ASSETS, rankCredibility } from "@/core/credibility";
import type { CredibilityAsset, Lead, Strategy } from "@/lib/types";

const lead: Lead = {
  id: "l1",
  instagram_handle: "founder",
  name: null,
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
  media_gap: "no written press",
  commercial_goal: "raising a seed round",
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
  credibility_needed: true,
  credibility_reason: null,
  should_explain_service: false,
};

function asset(over: Partial<CredibilityAsset>): CredibilityAsset {
  return {
    asset_type: "case_study",
    name: "Asset",
    approved_claim: "An approved claim.",
    niches: [],
    industries: [],
    ...over,
  };
}

test("a relevant approved asset is selected", () => {
  const ranked = rankCredibility(
    [
      asset({ name: "Fintech founder study", niches: ["SMB accounting"], industries: ["Fintech"], approved_claim: "Helped a fintech founder build search presence before a seed round." }),
      asset({ name: "Wedding photographer", niches: ["wedding photography"], industries: ["Events"], approved_claim: "Unrelated." }),
    ],
    lead,
    strategy,
  );
  assert.equal(ranked[0].name, "Fintech founder study");
});

test("nothing is returned when no asset is relevant — the writer must invent nothing", () => {
  const ranked = rankCredibility(
    [
      asset({ name: "Wedding photographer", niches: ["wedding photography"], industries: ["Events"], approved_claim: "Unrelated to anything here." }),
      asset({ name: "Restaurant group", niches: ["hospitality"], industries: ["Food"], approved_claim: "Also unrelated." }),
    ],
    lead,
    strategy,
  );
  assert.deepEqual(ranked, [], "padding with irrelevant proof invites name-dropping");
});

test("an empty approved table yields nothing rather than a fabrication", () => {
  assert.deepEqual(rankCredibility([], lead, strategy), []);
});

test("many relevant assets are capped to a handful", () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    asset({ name: `Fintech study ${i}`, industries: ["Fintech"], niches: ["SMB accounting"], approved_claim: "Fintech seed round credibility work." }),
  );
  const ranked = rankCredibility(many, lead, strategy);
  assert.ok(ranked.length <= MAX_ASSETS, `expected at most ${MAX_ASSETS}, got ${ranked.length}`);
  assert.ok(ranked.length >= 1);
});

test("ranking prefers the asset matching the prospect's own goal", () => {
  const ranked = rankCredibility(
    [
      asset({ name: "Generic fintech", industries: ["Fintech"], approved_claim: "General fintech work." }),
      asset({ name: "Seed round specific", industries: ["Fintech"], approved_claim: "Built credibility for a founder raising a seed round." }),
    ],
    lead,
    strategy,
  );
  assert.equal(ranked[0].name, "Seed round specific");
});

test("assets carry a relevance score so selection is auditable", () => {
  const ranked = rankCredibility(
    [asset({ name: "Fintech", industries: ["Fintech"], approved_claim: "Fintech seed round work." })],
    lead,
    strategy,
  );
  assert.ok(typeof ranked[0].relevance === "number" && ranked[0].relevance > 0);
});

test("only assets passed in can be selected — the ranker never invents one", () => {
  const input = [asset({ name: "Only Asset", industries: ["Fintech"], approved_claim: "Fintech work." })];
  const ranked = rankCredibility(input, lead, strategy);
  assert.ok(ranked.every((r) => input.some((i) => i.name === r.name)));
});
