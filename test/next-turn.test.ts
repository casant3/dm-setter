import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runSetterForLead, type AgentDeps } from "@/core/agent";
import { offlineLlm } from "@/core/offline-llm";
import { countQuestions, countWords } from "@/core/style";
import { LocalStore } from "@/lib/store/local-store";
import type { Sender } from "@/lib/types";

/**
 * Next-turn regression suite.
 *
 * Each case is a conversation state and the behaviour the operator asked for by
 * name. They run through the whole pipeline — context, evidence, gate, plan,
 * writer, reviewer, audit — so a regression anywhere in it fails here.
 *
 * Every fixture is synthetic.
 */

type Case = {
  name: string;
  why: string;
  service_explained?: boolean;
  messages: [Sender, string][];
  expect: {
    move?: string;
    not_move?: string;
    must_not_reask?: string[];
    no_call?: boolean;
    no_call_pitch?: boolean;
    no_question?: boolean;
    audit_ok?: boolean;
    max_words?: number;
    max_questions?: number;
    understanding_at_least?: number;
    avoid_money_framing?: boolean;
  };
};

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "next-turn.json"), "utf8"),
) as { cases: Case[] };

async function freshDeps(): Promise<AgentDeps> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-nextturn-"));
  return { store: new LocalStore(dir), llm: offlineLlm, voiceSetter: "Cassey" };
}

const CALL_PITCH = /\b(call|20 min|jump on|hop on|chat with avo|speak to avo)\b/i;
const MONEY_FRAMING = /\b(revenue|monetis|monetiz|roi|profit|sales target|paying clients)\b/i;

for (const testCase of fixture.cases) {
  test(`next turn: ${testCase.name}`, async () => {
    const deps = await freshDeps();
    const lead = await deps.store.createLead({ instagram_handle: `fixture_${fixture.cases.indexOf(testCase)}` });

    await deps.store.appendMessages(
      lead.id,
      testCase.messages.map(([sender, message_text]) => ({ sender, message_text })),
    );
    if (testCase.service_explained) {
      await deps.store.upsertMemory(lead.id, { lead_id: lead.id, service_explained: true });
    }

    const result = await runSetterForLead(lead.id, "", deps);
    const reply = result.reviewer.final_reply;
    const context = `${testCase.why} — got move=${result.plan.move}, reply="${reply}"`;

    if (testCase.expect.move) assert.equal(result.plan.move, testCase.expect.move, context);
    if (testCase.expect.not_move) assert.notEqual(result.plan.move, testCase.expect.not_move, context);

    for (const topic of testCase.expect.must_not_reask ?? []) {
      assert.ok(result.read.already_answered.includes(topic), `${topic} should be closed — ${context}`);
      assert.ok(
        !result.audit.violations.some((v) => v.rule === "already_answered"),
        `the suggested message re-asks it — ${context}`,
      );
    }

    if (testCase.expect.no_call) {
      assert.equal(result.gate.passed, false, `the gate must stay closed — ${context}`);
      assert.equal(result.strategy.call_ready, false, context);
    }
    if (testCase.expect.no_call_pitch || testCase.expect.no_call) {
      assert.doesNotMatch(reply, CALL_PITCH, `must not pitch a call — ${context}`);
    }
    if (testCase.expect.no_question) {
      assert.equal(countQuestions(reply), 0, `must not ask a question — ${context}`);
    }
    if (testCase.expect.audit_ok) {
      assert.equal(result.audit.ok, true, `audit violations: ${JSON.stringify(result.audit.violations)}`);
    }
    if (testCase.expect.max_words) {
      assert.ok(countWords(reply) <= testCase.expect.max_words, `${countWords(reply)} words — ${context}`);
    }
    if (testCase.expect.max_questions !== undefined) {
      assert.ok(countQuestions(reply) <= testCase.expect.max_questions, context);
    }
    if (testCase.expect.understanding_at_least !== undefined) {
      assert.ok(result.understanding.level >= testCase.expect.understanding_at_least, context);
    }
    if (testCase.expect.avoid_money_framing) {
      assert.doesNotMatch(reply, MONEY_FRAMING, `money framing at a mission-driven prospect — ${context}`);
    }
  });
}

test("every fixture case is exercised", () => {
  assert.ok(fixture.cases.length >= 12, "the regression suite should not shrink");
  assert.ok(fixture.cases.every((c) => c.why.trim().length > 0), "each case records why it exists");
});
