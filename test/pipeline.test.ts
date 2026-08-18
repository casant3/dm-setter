import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { evaluateGate, runSetterForLead, type AgentDeps } from "@/core/agent";
import { offlineLlm } from "@/core/offline-llm";
import { LocalStore } from "@/lib/store/local-store";
import type { Strategy } from "@/lib/types";

async function freshDeps(): Promise<AgentDeps> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-test-"));
  return { store: new LocalStore(dir), llm: offlineLlm };
}

function strategyWith(overrides: Partial<Strategy> = {}): Strategy {
  return {
    stage: "VALUE_BUILDING",
    qualification: {
      fit: 2,
      commercial_goal: 2,
      media_gap: 2,
      value_established: 2,
      service_understanding: 2,
      interest_signal: 2,
    },
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
    ...overrides,
  };
}

test("the hard gate passes only when every requirement is met", () => {
  assert.equal(evaluateGate(strategyWith()).passed, true);
});

test("the gate blocks a call when the prospect has no commercial goal", () => {
  const gate = evaluateGate(
    strategyWith({
      qualification: { ...strategyWith().qualification, commercial_goal: 0 },
      total_score: 10,
    }),
  );
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((b) => /commercial or authority goal/.test(b)));
});

test("the gate blocks a call while SERVICE_CONFUSION is unresolved", () => {
  const gate = evaluateGate(strategyWith({ service_confusion: true }));
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.includes("SERVICE_CONFUSION is unresolved"));
});

test("the gate blocks a call below the 9/12 qualification threshold", () => {
  const gate = evaluateGate(
    strategyWith({
      qualification: { fit: 1, commercial_goal: 1, media_gap: 1, value_established: 1, service_understanding: 1, interest_signal: 1 },
      total_score: 6,
    }),
  );
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((b) => /below the 9/.test(b)));
});

test("the gate overrides a model that wrongly declares a lead call-ready", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const cody = leads.find((l) => l.instagram_handle === "codyalt")!;

  const overconfident = {
    ...offlineLlm,
    async strategy() {
      return strategyWith({ service_confusion: true, confusion_reason: "asked what show this is", call_ready: true });
    },
  };

  const result = await runSetterForLead(cody.id, "what show is this for?", { store: deps.store, llm: overconfident });
  assert.equal(result.strategy.call_ready, false, "gate must override the model");
  assert.equal(result.gate.model_said_call_ready, true);
  assert.equal(result.gate.passed, false);
});

test("a podcast-guest question is detected as SERVICE_CONFUSION and the reply corrects the premise", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const cody = leads.find((l) => l.instagram_handle === "codyalt")!;

  const result = await runSetterForLead(cody.id, "how long is the pod? and what show is this for", deps);

  assert.equal(result.strategy.service_confusion, true);
  assert.equal(result.strategy.stage, "SERVICE_CONFUSION");
  assert.equal(result.strategy.qualification.service_understanding, 0);
  assert.equal(result.strategy.call_ready, false);
  assert.match(result.reviewer.final_reply, /isn't me inviting you on as a guest/i);
  assert.doesNotMatch(result.reviewer.final_reply, /\b20 minutes\b/);
});

test("retrieval returns both similar winners and similar failures", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const cody = leads.find((l) => l.instagram_handle === "codyalt")!;

  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);

  assert.ok(result.similar_winners.length > 0, "expected winner examples");
  assert.ok(result.similar_failures.length > 0, "expected failure examples");
  assert.ok(result.similar_winners.every((c) => ["📞 Onboarding Call", "📞 Discovery Call"].includes(c.outcome!)));
  assert.ok(result.similar_failures.every((c) => ["❌ Not Interested", "⚫ No show"].includes(c.outcome!)));
});

test("a fully qualified lead reaches the call step", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const mara = leads.find((l) => l.instagram_handle === "marasellsdesign")!;

  const result = await runSetterForLead(mara.id, "ok I like that. what happens next?", deps);

  assert.equal(result.strategy.service_confusion, false);
  assert.equal(result.gate.passed, true, `unexpected blockers: ${result.gate.blockers.join(", ")}`);
  assert.equal(result.strategy.call_ready, true);
  assert.match(result.reviewer.final_reply, /Avo/);
});

test("every generation is persisted as a suggestion for the feedback loop", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const cody = leads.find((l) => l.instagram_handle === "codyalt")!;

  const result = await runSetterForLead(cody.id, "how long is the pod?", deps);
  assert.ok(result.suggestion_id);

  const saved = await deps.store.listSuggestions(cody.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].suggested_message, result.reviewer.final_reply);
  assert.equal(saved[0].feedback, null);
  assert.ok(saved[0].examples_used.length > 0, "examples used should be recorded");
});

test("feedback records Used, Edited and Rejected and keeps the legacy booleans in sync", async () => {
  const deps = await freshDeps();
  const leads = await deps.store.listLeads();
  const cody = leads.find((l) => l.instagram_handle === "codyalt")!;
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
  assert.ok(edited.feedback_at);

  const rejected = await deps.store.recordFeedback(result.suggestion_id!, { feedback: "rejected" });
  assert.equal(rejected.feedback, "rejected");
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.accepted, false);
});
