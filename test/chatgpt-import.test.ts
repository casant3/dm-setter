import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractCandidatesFromPath,
  parseChatGptExport,
  reconstructPaths,
  type Conversation,
} from "@/core/chatgpt-import";
import { readOperatorFeedback } from "@/core/operator-feedback";

/**
 * Synthetic ChatGPT exports.
 *
 * Nothing here is a real conversation or a real prospect: the drafts are
 * invented and the "operator" messages are the phrasings the real feedback uses.
 */

type Node = { id: string; parent: string | null; children: string[]; role?: "user" | "assistant"; text?: string; at?: number };

/** Builds a `mapping` tree from a flat node list, the way an export stores one. */
function exportOf(title: string, nodes: Node[], currentNode: string | null = null): Conversation {
  const mapping: Record<string, unknown> = {};
  for (const n of nodes) {
    mapping[n.id] = {
      id: n.id,
      parent: n.parent,
      children: n.children,
      message: n.role
        ? { id: n.id, author: { role: n.role }, content: { parts: [n.text ?? ""] }, create_time: n.at ?? null }
        : null,
    };
  }
  return { title, mapping, current_node: currentNode } as Conversation;
}

const DRAFT_A = "Hey Sam — saw the clinic is opening a second site. What's the plan for getting the name known before it opens?";
const DRAFT_B = "Saw the second site is opening. What's the plan for getting known first?";
const DRAFT_C = "Makes sense. Most people find you by searching your name, and right now there's nothing there but your own feed — that's the bit worth fixing before the launch.";
const DRAFT_D = "Right now anyone searching you finds your own feed and nothing else. Before the launch, that's the gap worth closing.";

// ---------------------------------------------------------------------------
// A. Simple linear conversation
// ---------------------------------------------------------------------------

test("a linear conversation reconstructs as one path in order", () => {
  const conversation = exportOf(
    "DM for Sam",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write a DM to Sam, opening a clinic", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
      { id: "u2", parent: "a1", children: ["a2"], role: "user", text: "too long", at: 3 },
      { id: "a2", parent: "u2", children: ["u3"], role: "assistant", text: DRAFT_B, at: 4 },
      { id: "u3", parent: "a2", children: [], role: "user", text: "this is better, send this", at: 5 },
    ],
    "u3",
  );

  const paths = reconstructPaths(conversation);
  assert.equal(paths.length, 1);
  assert.deepEqual(
    paths[0].turns.map((t) => t.role),
    ["user", "assistant", "user", "assistant", "user"],
  );
  assert.equal(paths[0].is_active, true);
});

test("a linear coaching conversation becomes one correction pair", () => {
  const conversation = exportOf(
    "DM for Sam",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write a DM to Sam, opening a clinic", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
      { id: "u2", parent: "a1", children: ["a2"], role: "user", text: "too long", at: 3 },
      { id: "a2", parent: "u2", children: ["u3"], role: "assistant", text: DRAFT_B, at: 4 },
      { id: "u3", parent: "a2", children: [], role: "user", text: "this is better, send this", at: 5 },
    ],
    "u3",
  );

  const [candidate, ...rest] = parseChatGptExport(conversation);
  assert.equal(rest.length, 0);
  assert.equal(candidate.kind, "correction_pair");
  assert.equal(candidate.rejected_reply, DRAFT_A);
  assert.equal(candidate.operator_feedback, "too long");
  assert.equal(candidate.approved_reply, DRAFT_B);
  assert.deepEqual(candidate.tags, ["too_long"]);
  assert.match(candidate.prospect_message ?? "", /opening a clinic/);
});

// ---------------------------------------------------------------------------
// B. A regenerated response
// ---------------------------------------------------------------------------

/** One prompt, two assistant answers: the second replaced the first. */
const REGENERATED = exportOf(
  "Regenerated",
  [
    { id: "root", parent: null, children: ["u1"] },
    { id: "u1", parent: "root", children: ["a1", "a1b"], role: "user", text: "write the follow-up DM", at: 1 },
    { id: "a1", parent: "u1", children: [], role: "assistant", text: DRAFT_A, at: 2 },
    { id: "a1b", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_C, at: 3 },
    { id: "u2", parent: "a1b", children: [], role: "user", text: "too long", at: 4 },
  ],
  "u2",
);

test("a regenerated response is kept as its own branch", () => {
  const paths = reconstructPaths(REGENERATED);
  assert.equal(paths.length, 2, "two leaves, two paths");

  const active = paths.find((p) => p.is_active);
  assert.ok(active, "the export marks one of them current");
  assert.deepEqual(
    active.turns.map((t) => t.text),
    ["write the follow-up DM", DRAFT_C, "too long"],
  );
});

test("criticism after a regeneration attaches only to the draft it followed", () => {
  const candidates = parseChatGptExport(REGENERATED);

  const criticised = candidates.filter((c) => c.operator_feedback === "too long");
  assert.equal(criticised.length, 1, "only one draft was criticised");
  assert.equal(criticised[0].rejected_reply, DRAFT_C);
  assert.ok(
    candidates.every((c) => c.rejected_reply !== DRAFT_A || c.operator_feedback === null),
    "the replaced draft never inherits the feedback",
  );
});

// ---------------------------------------------------------------------------
// C. Two branches, each with its own feedback
// ---------------------------------------------------------------------------

test("two branches produce two independent chains", () => {
  const conversation = exportOf(
    "Branches",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1", "a2"], role: "user", text: "draft the value message", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_C, at: 2 },
      { id: "u2", parent: "a1", children: [], role: "user", text: "he already said that", at: 3 },
      { id: "a2", parent: "u1", children: ["u3"], role: "assistant", text: DRAFT_D, at: 4 },
      { id: "u3", parent: "a2", children: [], role: "user", text: "too salesy", at: 5 },
    ],
    "u3",
  );

  const candidates = parseChatGptExport(conversation);
  assert.equal(candidates.length, 2);

  const byDraft = new Map(candidates.map((c) => [c.rejected_reply, c]));
  assert.equal(byDraft.get(DRAFT_C)?.operator_feedback, "he already said that");
  assert.equal(byDraft.get(DRAFT_D)?.operator_feedback, "too salesy");
  assert.ok(byDraft.get(DRAFT_C)?.tags.includes("already_answered"));
  assert.ok(byDraft.get(DRAFT_D)?.tags.includes("too_salesy"));
});

test("object order in the mapping does not decide conversational order", () => {
  // The same conversation, with the nodes declared backwards in the file.
  const nodes: Node[] = [
    { id: "u3", parent: "a2", children: [], role: "user", text: "this is better", at: 5 },
    { id: "a2", parent: "u2", children: ["u3"], role: "assistant", text: DRAFT_B, at: 4 },
    { id: "u2", parent: "a1", children: ["a2"], role: "user", text: "too long", at: 3 },
    { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
    { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write a DM", at: 1 },
    { id: "root", parent: null, children: ["u1"] },
  ];
  const [path] = reconstructPaths(exportOf("Reversed", nodes, "u3"));

  assert.deepEqual(
    path.turns.map((t) => t.text),
    ["write a DM", DRAFT_A, "too long", DRAFT_B, "this is better"],
  );
});

// ---------------------------------------------------------------------------
// D & E. A full correction chain ending in approval
// ---------------------------------------------------------------------------

test("a multi-step correction chain keeps every draft and every criticism in order", () => {
  const conversation = exportOf(
    "Chain",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "he runs a clinic and wants more patients", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
      { id: "u2", parent: "a1", children: ["a2"], role: "user", text: "too long", at: 3 },
      { id: "a2", parent: "u2", children: ["u3"], role: "assistant", text: DRAFT_B, at: 4 },
      { id: "u3", parent: "a2", children: ["a3"], role: "user", text: "he already said that", at: 5 },
      { id: "a3", parent: "u3", children: ["u4"], role: "assistant", text: DRAFT_C, at: 6 },
      { id: "u4", parent: "a3", children: ["a4"], role: "user", text: "build more value, no call yet", at: 7 },
      { id: "a4", parent: "u4", children: ["u5"], role: "assistant", text: DRAFT_D, at: 8 },
      { id: "u5", parent: "a4", children: [], role: "user", text: "this is better", at: 9 },
    ],
    "u5",
  );

  const [chain, ...rest] = parseChatGptExport(conversation);
  assert.equal(rest.length, 0);
  assert.equal(chain.kind, "correction_chain");
  assert.equal(chain.revisions.length, 3);
  assert.deepEqual(
    chain.revisions.map((r) => r.feedback),
    ["too long", "he already said that", "build more value, no call yet"],
  );
  assert.deepEqual(
    chain.revisions.map((r) => r.reply),
    [DRAFT_A, DRAFT_B, DRAFT_C],
  );
  assert.equal(chain.approved_reply, DRAFT_D);
  for (const tag of ["too_long", "already_answered", "repeated_question", "weak_value", "premature_cta"]) {
    assert.ok(chain.tags.includes(tag as never), `expected tag ${tag}`);
  }
});

// ---------------------------------------------------------------------------
// Nothing is approved by accident
// ---------------------------------------------------------------------------

test("an assistant draft nobody responded to is not an approved example", () => {
  const conversation = exportOf(
    "No verdict",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write the DM", at: 1 },
      { id: "a1", parent: "u1", children: [], role: "assistant", text: DRAFT_A, at: 2 },
    ],
    "a1",
  );

  const candidates = parseChatGptExport(conversation);
  assert.deepEqual(candidates, [], "silence is not approval");
});

test("a draft followed by a new brief is not approved either", () => {
  const conversation = exportOf(
    "Moved on",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write the DM for Sam", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
      {
        id: "u2",
        parent: "a1",
        children: [],
        role: "user",
        text: "different prospect now — she runs a fintech and is raising a seed round next quarter, write something for her",
        at: 3,
      },
    ],
    "u2",
  );

  assert.ok(parseChatGptExport(conversation).every((c) => c.approved_reply === null));
});

test("every candidate is a proposal, and only explicit approval sets approved_reply", () => {
  const conversation = exportOf(
    "Mixed",
    [
      { id: "root", parent: null, children: ["u1"] },
      { id: "u1", parent: "root", children: ["a1"], role: "user", text: "write it", at: 1 },
      { id: "a1", parent: "u1", children: ["u2"], role: "assistant", text: DRAFT_A, at: 2 },
      { id: "u2", parent: "a1", children: ["a2"], role: "user", text: "too corporate", at: 3 },
      { id: "a2", parent: "u2", children: [], role: "assistant", text: DRAFT_B, at: 4 },
    ],
    "a2",
  );

  const [candidate] = parseChatGptExport(conversation);
  assert.equal(candidate.kind, "correction_pair");
  assert.equal(candidate.approved_reply, null, "nobody said it was good");
  assert.equal(candidate.better_reply, DRAFT_B, "but the next attempt is still worth reviewing");
});

// ---------------------------------------------------------------------------
// The feedback vocabulary
// ---------------------------------------------------------------------------

test("the operator's real phrasings map to the right tags", () => {
  const cases: [string, string][] = [
    ["too long", "too_long"],
    ["he already said that", "already_answered"],
    ["he already said he's open to opportunities", "already_answered"],
    ["you're asking the same thing again", "repeated_question"],
    ["this is just a statement", "dead_end_statement"],
    ["then where will this lead?", "dead_end_statement"],
    ["build more value, no call yet", "premature_cta"],
    ["he doesn't seem like the money hungry type", "money_frame_wrong"],
    ["don't make this about money", "money_frame_wrong"],
    ["he doesn't even know what we do", "service_not_clear"],
    ["make it sound human", "human_natural_tone"],
    ["less needy", "too_needy"],
    ["too pushy", "too_pushy"],
    ["don't give up yet", "gave_up_too_early"],
    ["sounds corporate", "too_corporate"],
    ["sounds robotic", "too_corporate"],
    ["too salesy", "too_salesy"],
  ];

  for (const [text, tag] of cases) {
    const reading = readOperatorFeedback(text);
    assert.equal(reading.kind, "criticism", `"${text}" should read as criticism`);
    assert.ok(reading.tags.includes(tag as never), `"${text}" should be tagged ${tag}, got ${reading.tags.join(",")}`);
  }
});

test("approval is recognised without being confused with praise-then-criticism", () => {
  for (const text of ["this is better", "send this", "I like this", "use this", "perfect"]) {
    assert.equal(readOperatorFeedback(text).kind, "approval", text);
  }
  // A compliment attached to a rejection is still a rejection.
  assert.equal(readOperatorFeedback("this is better but still too long").kind, "criticism");
});

test("an unexplained short reply is flagged for judgement rather than guessed at", () => {
  const reading = readOperatorFeedback("hmm not quite");
  assert.equal(reading.needs_model_judgement, true);
  assert.equal(reading.tags.length, 0);
  assert.equal(reading.confidence, "low");
});

test("a long message is treated as new context, never as feedback", () => {
  const long =
    "ok so for this next one the guy runs a longevity clinic in London, he's opening a second site in Q1, he's already told me he has no press at all and he mentioned he cares more about educating people properly than about revenue, so bear that in mind when you write the next message please";
  assert.equal(readOperatorFeedback(long).kind, "none");
});

test("a model may only fill in what the patterns could not read", () => {
  const path = {
    title: "Ambiguous",
    branch_index: 0,
    is_active: true,
    node_ids: ["u1", "a1", "u2"],
    turns: [
      { node_id: "u1", role: "user" as const, text: "write the DM", create_time: 1 },
      { node_id: "a1", role: "assistant" as const, text: DRAFT_A, create_time: 2 },
      { node_id: "u2", role: "user" as const, text: "nah, not like that", create_time: 3 },
    ],
  };

  // Without a classifier the ambiguous message is recorded, not interpreted.
  const [plain] = extractCandidatesFromPath(path);
  assert.equal(plain, undefined, "nothing is asserted about an unread reaction");

  const [judged] = extractCandidatesFromPath(path, () => ({ kind: "criticism", tags: ["too_corporate", "not_a_real_tag"] }));
  assert.equal(judged.kind, "bad_example");
  assert.deepEqual(judged.tags, ["too_corporate"], "unknown tags are dropped");
});

test("a plain message list with no mapping still imports", () => {
  const candidates = parseChatGptExport({
    title: "Flat",
    messages: [
      { author: { role: "user" }, content: "write the DM" },
      { author: { role: "assistant" }, content: DRAFT_A },
      { author: { role: "user" }, content: "too long" },
      { author: { role: "assistant" }, content: DRAFT_B },
      { author: { role: "user" }, content: "send this" },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].approved_reply, DRAFT_B);
});
