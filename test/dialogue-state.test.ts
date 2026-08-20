import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDialogueState, draftRepeatsAnsweredTopic, nextBestTopic } from "@/core/dialogue-state";
import { assessMotivation, draftMisframesMotivation } from "@/core/motivation";
import { classifyBrushOff, clarificationAlreadyUsed } from "@/core/brush-off";
import { assessTemperature } from "@/core/temperature";
import { emptyMemory, makeItem } from "@/core/memory";
import type { Message } from "@/lib/types";

/** All fixtures synthetic — no real prospect data in the repo. */
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

function thread(...pairs: [Message["sender"], string][]): Message[] {
  return pairs.map(([s, t], i) => msg(s, t, i));
}

// ---------------------------------------------------------------------------
// Semantic answer tracking — the operator's "he already said that"
// ---------------------------------------------------------------------------

test("openness answered in any wording closes the topic", () => {
  for (const reply of [
    "Yeah I'm always open to opportunities.",
    "I'm down to hear it out.",
    "sure, tell me more",
    "go on",
    "what did you have in mind?",
  ]) {
    const state = buildDialogueState(
      thread(["setter", "Would you be open to getting your story in front of more people?"], ["prospect", reply]),
      null,
    );
    assert.ok(state.topics.openness_interest.answered, `"${reply}" should close openness`);
    assert.ok(state.do_not_ask.includes("openness_interest"));
  }
});

test("a re-ask of an answered topic is caught even in different words", () => {
  const state = buildDialogueState(
    thread(["setter", "Would you be open to hearing more?"], ["prospect", "Yeah I'm always open to opportunities."]),
    null,
  );

  for (const bad of [
    "Would that be something you'd be open to exploring?",
    "Would you be open to hearing how it works?",
    "Is that something you'd want to explore?",
  ]) {
    assert.equal(draftRepeatsAnsweredTopic(bad, state), "openness_interest", `should flag: ${bad}`);
  }
});

test("a genuinely new question is not flagged as a repeat", () => {
  const state = buildDialogueState(
    thread(["setter", "Would you be open to hearing more?"], ["prospect", "I'm down to hear it out."]),
    null,
  );
  assert.equal(draftRepeatsAnsweredTopic("What comes up when someone searches your name?", state), null);
});

test("one answer can close several topics at once", () => {
  const state = buildDialogueState(
    thread(
      ["setter", "What are you building toward this year?"],
      ["prospect", "I run SkyMD and FitProtection, launching a new product in Q1, happy to hear more"],
    ),
    null,
  );
  assert.ok(state.topics.commercial_goal.answered);
  assert.ok(state.topics.timing.answered);
  assert.ok(state.topics.openness_interest.answered);
  assert.ok(!state.do_not_ask.includes("media_gap"), "media gap is still genuinely open");
});

test("long-term memory closes a topic whose message is long gone", () => {
  const memory = {
    ...emptyMemory("l1"),
    businesses: [makeItem("SkyMD", "fact", { quote: "I run SkyMD and FitProtection." })],
  };
  const state = buildDialogueState(thread(["setter", "hey"], ["prospect", "hi"]), memory);
  assert.ok(state.topics.commercial_goal.answered, "memory closes it even with no matching message");
  assert.match(state.topics.commercial_goal.answer_quote ?? "", /SkyMD/);
});

test("asked but unanswered stays an open loop", () => {
  const state = buildDialogueState(
    thread(["setter", "What comes up when someone looks you up?"], ["prospect", "haha good question"]),
    null,
  );
  assert.ok(state.open_loops.includes("media_gap"));
  assert.ok(!state.do_not_ask.includes("media_gap"));
});

test("the next best question skips everything already answered", () => {
  const state = buildDialogueState(
    thread(["setter", "What are you working on?"], ["prospect", "I'm building a fintech product, open to hearing more"]),
    null,
  );
  assert.equal(nextBestTopic(state), "media_gap", "goal and openness are done; the gap is next");
});

// ---------------------------------------------------------------------------
// Motivation framing
// ---------------------------------------------------------------------------

test("a mission-driven prospect is not framed commercially", () => {
  const m = assessMotivation([{ id: "m1", message_text: "I'm mainly trying to educate more patients properly" }], null);
  assert.equal(m.primary, "client_education");
  assert.equal(m.avoid_money_framing, true);
  assert.ok(draftMisframesMotivation("What kind of revenue are you trying to generate from your media?", m));
  assert.ok(!draftMisframesMotivation("How many more patients would you want to reach?", m));
});

test("a fundraising prospect gets the diligence frame", () => {
  const m = assessMotivation([{ id: "m1", message_text: "we're prepping a seed round for Q3" }], null);
  assert.equal(m.primary, "fundraising");
  assert.equal(m.avoid_money_framing, false);
  assert.match(m.guidance ?? "", /diligence/i);
});

test("a non-commercial frame outranks a commercial one when both appear", () => {
  const m = assessMotivation(
    [{ id: "m1", message_text: "we want more customers but honestly the mission is educating patients" }],
    null,
  );
  assert.equal(m.avoid_money_framing, true);
  assert.ok(["client_education", "mission"].includes(m.primary ?? ""));
});

test("no evidence means no assumed motivation", () => {
  const m = assessMotivation([{ id: "m1", message_text: "hey thanks for reaching out" }], null);
  assert.equal(m.primary, null);
  assert.equal(m.avoid_money_framing, false);
});

// ---------------------------------------------------------------------------
// Brush-offs
// ---------------------------------------------------------------------------

test("'I'm set thanks' before understanding is an uninformed brush-off", () => {
  const b = classifyBrushOff({ id: "m1", message_text: "I'm set thanks" }, { understandsService: false, serviceExplained: false });
  assert.equal(b.kind, "uninformed_brushoff");
  assert.equal(b.may_clarify_once, true);
  assert.equal(b.should_disengage, false);
});

test("the same words after understanding are an informed rejection", () => {
  const b = classifyBrushOff({ id: "m1", message_text: "I'm set thanks" }, { understandsService: true, serviceExplained: true });
  assert.equal(b.kind, "informed_rejection");
  assert.equal(b.may_clarify_once, false);
  assert.equal(b.should_disengage, true);
});

test("an explicit refusal always disengages", () => {
  const b = classifyBrushOff({ id: "m1", message_text: "not interested at all, please stop messaging me" }, { understandsService: false, serviceExplained: false });
  assert.equal(b.kind, "true_not_interested");
  assert.equal(b.should_disengage, true);
  assert.equal(b.may_clarify_once, false);
});

test("a deferral is a timing objection, not a rejection", () => {
  const b = classifyBrushOff({ id: "m1", message_text: "not right now, circle back next quarter" }, { understandsService: true, serviceExplained: true });
  assert.equal(b.kind, "timing_objection");
  assert.equal(b.should_disengage, false);
});

test("the one clarification allowance cannot be spent twice", () => {
  const messages = thread(["prospect", "I'm good thanks"], ["setter", "quick clarification"]);
  assert.equal(clarificationAlreadyUsed(messages, "m0"), true);
  assert.equal(clarificationAlreadyUsed(thread(["prospect", "I'm good thanks"]), "m0"), false);
});

test("an ordinary reply is not a brush-off", () => {
  const b = classifyBrushOff({ id: "m1", message_text: "yeah that makes sense, tell me more" }, { understandsService: false, serviceExplained: true });
  assert.equal(b.kind, "none");
});

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

test("a pricing question reads as high intent", () => {
  const messages = thread(["setter", "here's what we do"], ["prospect", "interesting — how much do you guys charge?"]);
  const t = assessTemperature(messages, buildDialogueState(messages, null));
  assert.equal(t.temperature, "high_intent");
  assert.match(t.guidance, /concrete call/i);
});

test("one-word replies read as guarded", () => {
  const messages = thread(["setter", "hey saw your post"], ["prospect", "ok"], ["setter", "what are you building?"], ["prospect", "sure"]);
  const t = assessTemperature(messages, buildDialogueState(messages, null));
  assert.equal(t.temperature, "guarded");
  assert.match(t.guidance, /low-pressure|do not pitch/i);
});

test("cooling is followed down rather than ignored", () => {
  const warm = thread(["prospect", "that makes sense, tell me more"]);
  const cooled = thread(["prospect", "that makes sense, tell me more"], ["setter", "..."], ["prospect", "ok"]);
  const a = assessTemperature(warm, buildDialogueState(warm, null));
  const b = assessTemperature(cooled, buildDialogueState(cooled, null));
  assert.ok(b.score < a.score, `cooled (${b.score}) should score below warm (${a.score})`);
});

test("no reply yet is neutral, not guarded", () => {
  const messages = thread(["setter", "opening message"]);
  const t = assessTemperature(messages, buildDialogueState(messages, null));
  assert.equal(t.temperature, "neutral");
});
