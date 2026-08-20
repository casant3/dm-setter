import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChunks } from "@/ingest/chunk";
import { handleFromCardName, orderScreenshots } from "@/ingest/dataset";
import { buildOutcomeHistory, parseProfileHints, signalsFromComments, type BoardExport } from "@/ingest/extract";
import { labelConversation } from "@/ingest/labels";
import { REVIEW_THRESHOLD, mergeScreenshots, type ScreenshotTranscription, type TranscribedMessage } from "@/ingest/transcribe";

/**
 * All fixtures here are synthetic. Real prospect DMs are private and must never
 * appear in the repository.
 */

function msg(sender: "setter" | "prospect", text: string, over: Partial<TranscribedMessage> = {}): TranscribedMessage {
  return {
    sender,
    text,
    confidence: 0.95,
    source_screenshot: "shot1",
    index_in_screenshot: 0,
    uncertain: false,
    ...over,
  };
}

function shot(id: string, messages: TranscribedMessage[], confidence = 0.95): ScreenshotTranscription {
  return {
    attachment_id: id,
    confidence,
    notes: null,
    messages: messages.map((m, i) => ({ ...m, source_screenshot: id, index_in_screenshot: i })),
  };
}

// ---------------------------------------------------------------------------
// Dataset identity
// ---------------------------------------------------------------------------

test("handles are parsed from Trello card names, including zero-width joiners", () => {
  assert.equal(handleFromCardName("@somehandle 21/07/26"), "somehandle");
  assert.equal(handleFromCardName("Some Person @their.handle 04/08/2026"), "their.handle");
  assert.equal(handleFromCardName("@‌somehandle"), "somehandle");
  assert.equal(handleFromCardName("Influencer contact follow-up"), null);
});

test("screenshots are ordered by the timestamp embedded in the attachment id", () => {
  const shots = [
    { attachment_id: "6a5fb3297e0772e784cb2def", entry: "c.png", zip: "z", part: 1, bytes: 1 },
    { attachment_id: "6a5fb2e259794a6b209b1b1c", entry: "a.png", zip: "z", part: 1, bytes: 1 },
    { attachment_id: "6a5fb2eb47e3b8eb699b1b63", entry: "b.png", zip: "z", part: 1, bytes: 1 },
  ];
  assert.deepEqual(
    orderScreenshots(shots).map((s) => s.entry),
    ["a.png", "b.png", "c.png"],
    "upload order, not filename order or part order",
  );
});

test("follower counts and descriptors are parsed from card descriptions", () => {
  assert.deepEqual(parseProfileHints("6.6k Followers, mortgage advisor & podcaster").followers, 6600);
  assert.deepEqual(parseProfileHints("14.7k \nDoctor/ entrepreneur").followers, 14700);
  assert.equal(parseProfileHints("2.1M followers").followers, 2_100_000);
  assert.equal(parseProfileHints("").followers, null);
  assert.match(parseProfileHints("3.5k | Founder- software").descriptor ?? "", /Founder/);
});

test("movement history is grouped per card, oldest first", () => {
  const board: BoardExport = {
    cards: [],
    lists: [],
    actions: [
      { type: "updateCard", date: "2026-08-02T00:00:00Z", data: { card: { shortLink: "abc" }, listBefore: { name: "📞 Discovery Call" }, listAfter: { name: "⚫ No show" } } },
      { type: "updateCard", date: "2026-08-01T00:00:00Z", data: { card: { shortLink: "abc" }, listBefore: { name: "🎯 New Leads (Warm)" }, listAfter: { name: "📞 Discovery Call" } } },
      { type: "commentCard", date: "2026-08-03T00:00:00Z", data: { card: { shortLink: "abc" }, text: "ignored here" } },
    ],
  };
  const history = buildOutcomeHistory(board).get("abc")!;
  assert.equal(history.length, 2);
  assert.equal(history[0].to, "📞 Discovery Call", "oldest first");
  assert.equal(history[1].to, "⚫ No show");
});

test("comments are mined for evidence a call actually happened", () => {
  assert.equal(signalsFromComments([{ text: "Great call. 2nd call underway" }]).showed, true);
  assert.equal(signalsFromComments([{ text: "Great call. 2nd call underway" }]).progressed, true);
  assert.equal(signalsFromComments([{ text: "Followed up (3rd of August)" }]).showed, false);
});

// ---------------------------------------------------------------------------
// Transcription merging
// ---------------------------------------------------------------------------

test("overlapping screenshots are deduplicated rather than duplicated", () => {
  const a = shot("s1", [msg("setter", "hey saw your launch post"), msg("prospect", "thanks! appreciate it")]);
  const b = shot("s2", [
    msg("prospect", "thanks! appreciate it"), // overlap
    msg("setter", "what are you building toward?"),
  ]);

  const merged = mergeScreenshots([a, b]);
  assert.equal(merged.messages.length, 3, "the shared message appears once");
  assert.equal(merged.duplicates_removed, 1);
  assert.equal(merged.ordering_confidence, 1, "the overlap corroborates that these are adjacent");
});

test("a truncated repeat of a message is recognised as the same message", () => {
  const a = shot("s1", [msg("prospect", "honestly not much comes up when people search for me at all")]);
  const b = shot("s2", [msg("prospect", "honestly not much comes up")]);
  const merged = mergeScreenshots([a, b]);
  assert.equal(merged.messages.length, 1);
  assert.match(merged.messages[0].text, /search for me at all/, "the fuller reading is kept");
});

test("screenshots that share nothing lower the ordering confidence", () => {
  const a = shot("s1", [msg("setter", "completely unrelated first thread")]);
  const b = shot("s2", [msg("prospect", "entirely different second thread")]);
  const merged = mergeScreenshots([a, b]);
  assert.equal(merged.duplicates_removed, 0);
  assert.equal(merged.ordering_confidence, 0, "no overlap means the order is unconfirmed");
});

test("unreadable text is flagged, never guessed", () => {
  const merged = mergeScreenshots([
    shot("s1", [msg("prospect", "we're raising a [unreadable] round", { uncertain: true, confidence: 0.4 })], 0.5),
  ]);
  assert.equal(merged.uncertain_message_count, 1);
  assert.ok(merged.transcript_confidence < REVIEW_THRESHOLD, "low confidence must be visible to a reviewer");
  assert.match(merged.messages[0].text, /\[unreadable\]/);
});

test("every merged transcript starts as needs_review, never verified", () => {
  const merged = mergeScreenshots([shot("s1", [msg("setter", "hello")], 1)]);
  assert.equal(merged.status, "needs_review", "a machine transcript is never ground truth");
});

test("a message repeated much later is not mistaken for an overlap", () => {
  const filler = Array.from({ length: 14 }, (_, i) => msg("setter", `filler ${i}`));
  const merged = mergeScreenshots([shot("s1", [msg("prospect", "sounds good"), ...filler]), shot("s2", [msg("prospect", "sounds good")])]);
  assert.equal(merged.messages.length, 16, "the later repeat is kept as its own message");
});

// ---------------------------------------------------------------------------
// Labels and quality
// ---------------------------------------------------------------------------

const goodConversation: TranscribedMessage[] = [
  msg("setter", "saw your post about the course launch — what are you building toward this year?"),
  msg("prospect", "launching a paid programme in the autumn"),
  msg("setter", "what comes up when someone searches you right now?"),
  msg("prospect", "honestly not much, nothing outside my own feed"),
  msg("setter", "that's the gap. written media and search presence give you third-party credibility ahead of the launch — that's something we help clients with"),
  msg("prospect", "makes sense, what does working with you look like?"),
  msg("setter", "Avo runs those conversations — worth 20 minutes with him this week?"),
];

const prematureConversation: TranscribedMessage[] = [
  msg("setter", "hey, love your content"),
  msg("prospect", "thanks!"),
  msg("setter", "want to grab a call with Avo this week?"),
  msg("prospect", "sure ok"),
];

test("a well-run conversation that onboarded scores highly", () => {
  const labels = labelConversation(goodConversation, "A");
  assert.equal(labels.commercial_goal_discovered, true);
  assert.equal(labels.media_gap_identified, true);
  assert.equal(labels.service_explained, true);
  assert.equal(labels.cta_used, true);
  assert.equal(labels.premature_cta, false);
  assert.ok(labels.quality_score >= 4, `expected a high score, got ${labels.quality_score}`);
  assert.ok(labels.value_props_used.length > 0);
});

test("a CTA fired before qualification is labelled premature", () => {
  const labels = labelConversation(prematureConversation, "E");
  assert.equal(labels.cta_used, true);
  assert.equal(labels.premature_cta, true);
  assert.equal(labels.failed_angle, "CTA before qualification");
  assert.ok(labels.quality_score <= 1.5, `a no-show from a premature CTA should score low, got ${labels.quality_score}`);
});

test("a booked call that later went cold scores below one that onboarded", () => {
  const onboarded = labelConversation(goodConversation, "A").quality_score;
  const wentCold = labelConversation(goodConversation, "F").quality_score;
  assert.ok(onboarded > wentCold, `${onboarded} should beat ${wentCold}`);
});

test("unresolved service confusion is recorded and penalised", () => {
  const confused: TranscribedMessage[] = [
    msg("setter", "would love to chat about your authority positioning"),
    msg("prospect", "how long is the pod?"),
    msg("setter", "about 45 minutes, want to book in?"),
    msg("prospect", "I don't pay to be on podcasts"),
  ];
  const labels = labelConversation(confused, "F");
  assert.equal(labels.service_confusion, true);
  assert.equal(labels.confusion_resolved, false, "the setter never corrected the premise");
  assert.equal(labels.premature_cta, true);
  assert.ok(labels.objections.includes("will not pay"));
});

test("resolved confusion is distinguished from unresolved", () => {
  const resolved: TranscribedMessage[] = [
    msg("prospect", "what podcast is this for?"),
    msg("setter", "not a guest invite — this is what we do for clients: media placement and positioning"),
    msg("prospect", "ah got it, what's the pricing?"),
  ];
  const labels = labelConversation(resolved, "A");
  assert.equal(labels.service_confusion, true);
  assert.equal(labels.confusion_resolved, true);
});

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

test("chunks carry the outcome tier and warn when the example is a failure", () => {
  const labels = labelConversation(prematureConversation, "E");
  const chunks = buildChunks({
    conversationId: "conv-1",
    messages: prematureConversation,
    labels,
    outcome: "⚫ No show",
    outcome_tier: "E",
    niche: "coaching",
    industry: "Coaching",
    setter_name: "William",
    handle: "synthetic",
  });

  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.outcome_tier === "E"));
  assert.ok(chunks.every((c) => c.setter_name === "William"));
  assert.ok(
    chunks.some((c) => /premature/i.test(c.content)),
    "a failure chunk must read as a warning, not a template",
  );
  assert.equal(chunks[0].metadata!.premature_cta, true);
});

test("chunks are bounded in size", () => {
  const long = Array.from({ length: 40 }, (_, i) => msg(i % 2 ? "prospect" : "setter", `message number ${i}`));
  const chunks = buildChunks({
    conversationId: "c",
    messages: long,
    labels: labelConversation(long, "C"),
    outcome: "📞 Discovery Call",
    outcome_tier: "C",
    niche: null,
    industry: null,
    setter_name: null,
    handle: null,
  });
  assert.ok(chunks.length > 1, "a long conversation is split");
  for (const c of chunks) {
    const lines = c.content.split("\n").length - 1;
    assert.ok(lines <= 8, `chunk had ${lines} messages`);
  }
});
