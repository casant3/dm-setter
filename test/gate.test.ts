import assert from "node:assert/strict";
import { test } from "node:test";
import { QUALIFICATION_DIMENSIONS, evaluateGate, totalScore } from "@/core/gate";
import type { Qualification, Strategy } from "@/lib/types";

function strategyWith(q: Partial<Qualification> = {}, overrides: Partial<Strategy> = {}): Strategy {
  const qualification: Qualification = {
    fit: 2,
    commercial_goal: 2,
    media_gap: 2,
    value_established: 2,
    service_understanding: 2,
    interest_signal: 2,
    ...q,
  };
  return {
    stage: "CALL_READY",
    qualification,
    total_score: totalScore(qualification),
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

test("a fully qualified lead passes the gate", () => {
  const gate = evaluateGate(strategyWith());
  assert.equal(gate.passed, true, gate.blockers.join("; "));
  assert.equal(gate.total_score, 12);
  assert.deepEqual(gate.missing_dimensions, []);
});

test("every single dimension at zero is a hard blocker on its own", () => {
  for (const dimension of QUALIFICATION_DIMENSIONS) {
    // 11/12 — comfortably over the threshold, failing only on this dimension.
    const gate = evaluateGate(strategyWith({ [dimension]: 0 } as Partial<Qualification>));
    assert.equal(gate.passed, false, `${dimension}=0 must block a call`);
    assert.ok(gate.missing_dimensions.includes(dimension), `${dimension} should be reported as missing`);
  }
});

test("a high total never compensates for a missing dimension", () => {
  // The exact profile from the brief: 2/2/0/2/2/2 = 10, over the threshold.
  const gate = evaluateGate(strategyWith({ media_gap: 0 }));
  assert.equal(gate.total_score, 10);
  assert.equal(gate.passed, false, "10/12 with no media gap must still be blocked");
  assert.deepEqual(gate.missing_dimensions, ["media_gap"]);
});

test("no interest signal prevents booking however strong the rest is", () => {
  const gate = evaluateGate(strategyWith({ interest_signal: 0 }));
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((b) => /interest signal/i.test(b)));
});

test("the gate blocks below the 9/12 threshold even with every dimension present", () => {
  const gate = evaluateGate(
    strategyWith({ fit: 1, commercial_goal: 1, media_gap: 1, value_established: 1, service_understanding: 1, interest_signal: 1 }),
  );
  assert.deepEqual(gate.missing_dimensions, [], "all dimensions are present");
  assert.equal(gate.total_score, 6);
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((b) => /below the 9/.test(b)));
});

test("exactly 9 with every dimension present is allowed", () => {
  const gate = evaluateGate(
    strategyWith({ fit: 2, commercial_goal: 2, media_gap: 1, value_established: 1, service_understanding: 2, interest_signal: 1 }),
  );
  assert.equal(gate.total_score, 9);
  assert.equal(gate.passed, true, gate.blockers.join("; "));
});

test("SERVICE_CONFUSION closes the gate on an otherwise perfect lead", () => {
  const gate = evaluateGate(strategyWith({}, { service_confusion: true, confusion_reason: "Asked what show this is for" }));
  assert.equal(gate.passed, false);
  assert.ok(gate.blockers.some((b) => /SERVICE_CONFUSION/.test(b)));
  assert.ok(gate.blockers.some((b) => /what show this is for/.test(b)), "the reason is surfaced");
});

test("the gate reports every blocker, not just the first", () => {
  const gate = evaluateGate(
    strategyWith({ media_gap: 0, interest_signal: 0 }, { service_confusion: true }),
  );
  assert.equal(gate.missing_dimensions.length, 2);
  assert.ok(gate.blockers.length >= 3, `expected several blockers, got ${gate.blockers.length}`);
});

test("the gate records what the model wanted, so disagreement is visible", () => {
  const wanted = evaluateGate(strategyWith({ media_gap: 0 }, { call_ready: true }));
  assert.equal(wanted.model_said_call_ready, true);
  assert.equal(wanted.passed, false);
});
