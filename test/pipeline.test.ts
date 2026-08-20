import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultDeps, recordExchange, runSetterForLead, type AgentDeps } from "@/core/agent";
import { offlineLlm } from "@/core/offline-llm";
import { LocalStore } from "@/lib/store/local-store";
import type { Strategy } from "@/lib/types";

async function freshDeps(): Promise<AgentDeps> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-test-"));
  return { store: new LocalStore(dir), llm: offlineLlm, voiceSetter: "Cassey" };
}

async function leadByHandle(deps: AgentDeps, handle: string) {
  const lead = await deps.store.getLeadByHandle(handle);
  assert.ok(lead, `seed lead ${handle} should exist`);
  return lead!;
}

function strategyWith(overrides: Partial<Strategy> = {}): Strategy {
  return {
    stage: "CALL_READY",
    qualification: { fit: 2, commercial_goal: 2, media_gap: 2, value_established: 2, service_understanding: 2, interest_signal: 2 },
    total_score: 12,
    call_ready: true,
    service_confusion: false,
    confusion_reason: null,
    next_objective: "book",
    strategy: "book",
    missing_information: [],
    credibility_needed: false,
    credibility_reason: null,
    should_explain_service: false,
    evidence: [],
    ...overrides,
  };
}

test("a podcast-guest question is detected as SERVICE_CONFUSION and the reply corrects the premise", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  const result = await runSetterForLead(cody.id, "how long is the pod? and what show is this for", deps);

  assert.equal(result.strategy.service_confusion, true);
  assert.equal(result.strategy.stage, "SERVICE_CONFUSION");
  assert.equal(result.strategy.qualification.service_understanding, 0);
  assert.equal(result.strategy.call_ready, false);
  assert.equal(result.gate.passed, false);
  assert.match(result.reviewer.final_reply, /isn't me inviting you on as a guest/i);
  assert.doesNotMatch(result.reviewer.final_reply, /\b20 minutes\b/);
});

test("the deterministic gate overrides a model that wrongly declares a lead call-ready", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  const overconfident = {
    ...offlineLlm,
    async strategy() {
      return strategyWith({ service_confusion: true, confusion_reason: "asked what show this is" });
    },
  };

  const result = await runSetterForLead(cody.id, "what show is this for?", { ...deps, llm: overconfident });
  assert.equal(result.strategy.call_ready, false, "gate must override the model");
  assert.equal(result.gate.model_said_call_ready, true);
  assert.equal(result.gate.passed, false);
});

test("a model claiming full understanding is overruled by the prospect's own words", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  // Cody's history contains confusion and no commercial engagement.
  const optimistic = { ...offlineLlm, async strategy() { return strategyWith(); } };

  const result = await runSetterForLead(cody.id, "cool", { ...deps, llm: optimistic });
  assert.equal(result.strategy.qualification.service_understanding, 0, "evidence, not the model, sets understanding");
  assert.equal(result.gate.passed, false);
});

test("retrieval returns labelled winners and failures, and failures are marked as such", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);

  assert.ok(result.examples.strong_winners.length > 0, "expected winner examples");
  assert.ok(result.examples.failures.length > 0, "expected failure examples");
  assert.ok(result.examples.failures.every((c) => c.evidence_class === "failure"));
  assert.ok(result.examples.strong_winners.every((c) => c.outcome_tier === "A"));
  const overlap = result.examples.strong_winners.filter((w) =>
    result.examples.failures.some((f) => f.id === w.id),
  );
  assert.equal(overlap.length, 0, "a chunk must never appear as both a winner and a failure");
});

test("voice examples come only from Cassey", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");
  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);
  assert.ok(result.examples.voice_examples.every((c) => c.setter_name === "Cassey"));
});

test("a fully qualified lead reaches the call step", async () => {
  const deps = await freshDeps();
  const mara = await leadByHandle(deps, "marasellsdesign");

  const result = await runSetterForLead(mara.id, "ok I like that. what happens next?", deps);

  assert.equal(result.strategy.service_confusion, false);
  assert.equal(result.gate.passed, true, `unexpected blockers: ${result.gate.blockers.join(", ")}`);
  assert.equal(result.strategy.call_ready, true);
  assert.match(result.reviewer.final_reply, /Avo/);
});

test("late confusion re-closes the gate on a lead that was call-ready", async () => {
  const deps = await freshDeps();
  const mara = await leadByHandle(deps, "marasellsdesign");

  const ready = await runSetterForLead(mara.id, "sounds good", deps);
  assert.equal(ready.gate.passed, true, "Mara starts call-ready");

  // She now reveals she thought this was a podcast booking all along.
  await deps.store.appendMessages(mara.id, [
    { sender: "prospect", message_text: "wait — how long is the pod, and which show is it for?" },
  ]);

  const after = await runSetterForLead(mara.id, "how long is the pod?", deps);
  assert.equal(after.strategy.service_confusion, true);
  assert.equal(after.gate.passed, false, "the gate must close again");
  assert.equal(after.strategy.qualification.service_understanding, 0);
  assert.ok(after.gate.blockers.some((b) => /SERVICE_CONFUSION/.test(b)));
});

test("credibility is not dumped, and nothing irrelevant is offered", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");
  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);
  assert.ok(result.credibility_used.length <= 5, "at most a handful of proof points");
});

test("every generation is persisted with its gate and engine recorded", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);
  assert.ok(result.suggestion_id);

  const saved = await deps.store.listSuggestions(cody.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].suggested_message, result.reviewer.final_reply);
  assert.equal(saved[0].feedback, null);
  assert.equal((saved[0].context_used as { engine?: string }).engine, "offline");
  assert.ok((saved[0].context_used as { gate?: unknown }).gate);
});

test("feedback records Used, Edited and Rejected and keeps the legacy booleans in sync", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");
  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);

  const edited = await deps.store.recordFeedback(result.suggestion_id!, {
    feedback: "edited",
    final_message_sent: "my own rewrite",
  });
  assert.equal(edited.feedback, "edited");
  assert.equal(edited.edited, true);
  assert.equal(edited.rejected, false);
  assert.equal(edited.accepted, true);
  assert.equal(edited.final_message_sent, "my own rewrite");
  assert.equal(edited.suggested_message, result.reviewer.final_reply, "the original suggestion is preserved");

  const rejected = await deps.store.recordFeedback(result.suggestion_id!, { feedback: "rejected" });
  assert.equal(rejected.feedback, "rejected");
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.accepted, false);
});

test("feedback statistics are computable from stored suggestions", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");
  const a = await runSetterForLead(cody.id, "how long is the pod?", deps);
  await deps.store.recordFeedback(a.suggestion_id!, { feedback: "edited", final_message_sent: "rewritten" });

  const stats = await deps.store.feedbackStats();
  assert.ok(stats.by_feedback.some((r) => r.feedback === "edited" && r.count === 1));
  assert.equal(stats.recent_edits.length, 1);
  assert.equal(stats.recent_edits[0].sent, "rewritten");
  assert.ok(stats.by_stage.length > 0);
});

test("an important fact from far outside the recent window still reaches the model", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "cody_longhistory", name: "Cody" });

  // The fact that matters, stated once at the very beginning.
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "What are you working on?", sent_at: new Date(2026, 0, 1).toISOString() },
    { sender: "prospect", message_text: "I run SkyMD and FitProtection.", sent_at: new Date(2026, 0, 2).toISOString() },
  ]);
  await deps.store.upsertMemory(lead.id, {
    businesses: [
      { value: "SkyMD", provenance: "fact", confidence: 1, recorded_at: new Date().toISOString(), quote: "I run SkyMD and FitProtection." },
      { value: "FitProtection", provenance: "fact", confidence: 1, recorded_at: new Date().toISOString(), quote: "I run SkyMD and FitProtection." },
    ],
  });

  // Bury it under far more than the 16-message recent window.
  const filler = [];
  for (let i = 0; i < 40; i += 1) {
    filler.push({
      sender: (i % 2 === 0 ? "setter" : "prospect") as "setter" | "prospect",
      message_text: `filler message ${i}`,
      sent_at: new Date(2026, 1, i + 1).toISOString(),
    });
  }
  await deps.store.appendMessages(lead.id, filler);

  const { loadLeadContext, compactContext } = await import("@/core/context");
  const ctx = await loadLeadContext(deps.store, lead.id, "yeah both");
  const serialized = compactContext(ctx);

  assert.equal(ctx.recentMessages.length, 16, "the window is still bounded");
  assert.ok(!ctx.recentMessages.some((m) => m.message_text.includes("SkyMD")), "the fact is outside the window");
  assert.match(serialized, /SkyMD/, "but long-term memory still supplies it");
  assert.match(serialized, /FitProtection/);
});

test("memory advances when a message is actually sent", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "memtest" });

  await recordExchange(deps.store, lead.id, strategyWith({ call_ready: false }), "What are you building toward this year?");

  const memory = await deps.store.getMemory(lead.id);
  assert.ok(memory);
  assert.deepEqual(
    memory!.questions_already_asked.map((q) => q.value),
    ["What are you building toward this year?"],
  );
});

test("defaultDeps selects the offline engine when no API key is configured", () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.equal(defaultDeps().llm.engine, "offline");
  } finally {
    if (previous) process.env.OPENAI_API_KEY = previous;
  }
});

// ---------------------------------------------------------------------------
// Message planning and the deterministic audit
// ---------------------------------------------------------------------------

test("every suggestion carries the move it makes and what happens after they reply", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");

  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);

  assert.equal(result.plan.move, "correct_premise");
  assert.ok(result.plan.purpose.length > 0);
  assert.ok(result.plan.desired_response.length > 0);
  assert.ok(result.plan.next_if_positive.length > 0);
  assert.ok(result.plan.next_if_negative.length > 0);
  assert.ok(result.plan.next_if_no_reply.length > 0);
});

test("a rewrite that re-asks an answered question is caught after the reviewer, not before", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "already_answered" });
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "Would you be open to hearing more about it?" },
    { sender: "prospect", message_text: "Yeah I'm always open to opportunities." },
  ]);

  // A reviewer that approves a message repeating a question they already answered.
  const sloppy = {
    ...offlineLlm,
    async review() {
      return {
        approved: true,
        issues: [],
        final_reply: "Would that be something you'd be open to exploring?",
        message_purpose: "check interest",
      };
    },
  };

  const result = await runSetterForLead(lead.id, "sure", { ...deps, llm: sloppy });
  assert.equal(result.audit.ok, false, "the audit runs on the final reply, not just the draft");
  assert.ok(result.audit.violations.some((v) => v.rule === "already_answered"));
  assert.equal(result.reviewer.approved, false, "an approval cannot survive a hard violation");
  assert.ok(result.read.already_answered.includes("openness_interest"));
});

test("a model that invents a supporting quote gains nothing from it", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "quote_inventor" });
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "hey, saw your work" },
    { sender: "prospect", message_text: "thanks" },
  ]);

  const fabricator = {
    ...offlineLlm,
    async strategy() {
      return strategyWith({
        evidence: [
          { dimension: "media_gap", quote: "I really need press before my launch" },
          { dimension: "commercial_goal", quote: "I am raising a Series A next quarter" },
        ],
      });
    },
  };

  const result = await runSetterForLead(lead.id, "thanks", { ...deps, llm: fabricator });
  assert.equal(result.strategy.qualification.media_gap, 0);
  assert.equal(result.strategy.qualification.commercial_goal, 0);
  assert.equal(result.gate.passed, false);
  assert.ok(
    (result.strategy.evidence_adjustments ?? []).some((a) => /not found in the conversation/.test(a)),
    "the fabrication is recorded, not silently ignored",
  );
});

test("a real quote from the conversation is accepted and lifts the score by one", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "quote_real" });
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "what are you working on?" },
    { sender: "prospect", message_text: "I'm launching a second clinic in Q1" },
  ]);

  const honest = {
    ...offlineLlm,
    async strategy() {
      return strategyWith({ evidence: [{ dimension: "commercial_goal", quote: "launching a second clinic in Q1" }] });
    },
  };

  const result = await runSetterForLead(lead.id, "", { ...deps, llm: honest });
  assert.equal(result.strategy.qualification.commercial_goal, 2, "one evidenced point plus one verified quote");
});

test("a goal the patterns miss still scores partially on a verified quote, never fully", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "quote_partial" });
  await deps.store.appendMessages(lead.id, [
    { sender: "setter", message_text: "what are you working on?" },
    { sender: "prospect", message_text: "mainly getting the clinic in front of the right patients" },
  ]);

  const honest = {
    ...offlineLlm,
    async strategy() {
      return strategyWith({
        evidence: [{ dimension: "commercial_goal", quote: "getting the clinic in front of the right patients" }],
      });
    },
  };

  const result = await runSetterForLead(lead.id, "", { ...deps, llm: honest });
  assert.equal(
    result.strategy.qualification.commercial_goal,
    1,
    "the quote is real, so it counts — but one verified quote never buys a full score on its own",
  );
});

test("the suggestion stored for a lead records the plan and the audit", async () => {
  const deps = await freshDeps();
  const cody = await leadByHandle(deps, "codyalt");
  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);

  const [saved] = await deps.store.listSuggestions(cody.id);
  const used = saved.context_used as { plan?: { move?: string }; audit?: { ok?: boolean } };
  assert.equal(used.plan?.move, "correct_premise");
  assert.equal(typeof used.audit?.ok, "boolean");
});

test("verified research reaches the model, unverified does not, and neither qualifies the lead", async () => {
  const deps = await freshDeps();
  const lead = await deps.store.createLead({ instagram_handle: "research_subject" });
  const now = new Date().toISOString();
  await deps.store.upsertMemory(lead.id, {
    lead_id: lead.id,
    research_facts: [
      {
        value: "opened a second clinic in Leeds",
        provenance: "research",
        confidence: 1,
        recorded_at: now,
        quote: "practice website",
        source_ref: "https://example.invalid/about",
        verified: true,
      },
      {
        value: "rumoured to be raising",
        provenance: "research",
        confidence: 0.4,
        recorded_at: now,
        quote: null,
        verified: false,
      },
    ],
  });

  const { loadLeadContext, compactContext } = await import("@/core/context");
  const serialized = compactContext(await loadLeadContext(deps.store, lead.id, ""));
  assert.match(serialized, /second clinic in Leeds/);
  assert.doesNotMatch(serialized, /rumoured to be raising/, "unverified research is withheld from the model entirely");
  assert.match(serialized, /unverified_research_withheld": 1/);
  assert.match(serialized, /Only verified facts are given to you/);

  const result = await runSetterForLead(lead.id, "", deps);
  assert.equal(result.strategy.qualification.commercial_goal, 0, "research is not qualification evidence");
  assert.equal(result.gate.passed, false);
  assert.equal(result.plan.move, "cold_opener");
});
