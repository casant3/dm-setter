import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDmTranscript, sequenceTimestamps } from "@/lib/dm-parser";

test("parses Me/Them style threads", () => {
  const { messages, warnings } = parseDmTranscript(
    ["Me: hey Cody, saw your post", "Them: thanks! appreciate it", "Me: what are you building toward?"].join("\n"),
  );
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.map((m) => m.sender),
    ["setter", "prospect", "setter"],
  );
  assert.equal(messages[1].message_text, "thanks! appreciate it");
  assert.deepEqual(warnings, []);
});

test("recognises the prospect by handle and name", () => {
  const { messages, unknownLabels } = parseDmTranscript("@codyalt: hey\nCassey: hi there", {
    prospectAliases: ["codyalt", "Cody Alton"],
  });
  assert.deepEqual(
    messages.map((m) => m.sender),
    ["prospect", "setter"],
  );
  assert.deepEqual(unknownLabels, []);
});

test("handles Instagram export markers on their own line", () => {
  const { messages } = parseDmTranscript(
    ["You sent", "how far along is the raise?", "codyalt", "the raise is in progress"].join("\n"),
    { prospectAliases: ["codyalt"] },
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].sender, "setter");
  assert.equal(messages[0].message_text, "how far along is the raise?");
  assert.equal(messages[1].sender, "prospect");
  assert.equal(messages[1].message_text, "the raise is in progress");
});

test("keeps unlabelled lines after a marker as one message", () => {
  const { messages } = parseDmTranscript("You sent\nhey there\nquick question for you");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, "setter");
  assert.equal(messages[0].message_text, "hey there\nquick question for you");
});

test("treats wrapped lines as continuations, not new messages", () => {
  const { messages } = parseDmTranscript("Them: honestly not much\nour site and LinkedIn is about it");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message_text, "honestly not much\nour site and LinkedIn is about it");
});

test("does not mistake mid-sentence colons for speaker labels", () => {
  const { messages } = parseDmTranscript("Them: here's the thing. my worry is this: nobody knows us");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sender, "prospect");
});

test("keeps leading timestamps out of the message body", () => {
  const { messages } = parseDmTranscript("[10:32] Me: quick question\n[10:35] Them: sure");
  assert.equal(messages[0].message_text, "quick question");
  assert.equal(messages[1].message_text, "sure");
});

test("warns about unrecognised speaker labels and defaults them to the prospect", () => {
  const { messages, unknownLabels, warnings } = parseDmTranscript("Jordan: is this a paid thing?");
  assert.equal(messages[0].sender, "prospect");
  assert.deepEqual(unknownLabels, ["Jordan"]);
  assert.match(warnings[0], /Unrecognised speaker labels/);
});

test("reports empty pastes rather than importing nothing silently", () => {
  const { messages, warnings } = parseDmTranscript("   \n\n  ");
  assert.equal(messages.length, 0);
  assert.match(warnings[0], /No messages found/);
});

test("sequences timestamps in order, oldest first", () => {
  const { messages } = parseDmTranscript("Me: one\nThem: two\nMe: three");
  const sequenced = sequenceTimestamps(messages, new Date("2026-08-18T12:00:00.000Z"));
  assert.deepEqual(
    sequenced.map((m) => m.sent_at),
    ["2026-08-18T11:58:00.000Z", "2026-08-18T11:59:00.000Z", "2026-08-18T12:00:00.000Z"],
  );
});
