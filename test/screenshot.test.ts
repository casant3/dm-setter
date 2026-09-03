import assert from "node:assert/strict";
import { test } from "node:test";
import { needsReview, newLinesOnly, validateLines, type ScreenshotLine } from "@/core/screenshot";
import { parseSheetUrl } from "@/core/sheets-source";
import type { Message } from "@/lib/types";

/**
 * Reading a conversation from a screenshot.
 *
 * The rule these tests defend is that a screenshot may never put words in a
 * prospect's mouth. Everything here is synthetic: the risk is real transcripts,
 * so the fixtures are invented.
 */

let counter = 0;
function message(sender: "setter" | "prospect", text: string): Message {
  counter += 1;
  return {
    id: `m${counter}`,
    lead_id: "lead-1",
    sender,
    message_text: text,
    message_type: null,
    sent_at: new Date(Date.UTC(2026, 0, 1, 12, counter)).toISOString(),
    channel: "instagram",
    is_question: null,
    is_cta: null,
    is_objection: null,
    is_buying_signal: null,
    sent_by_ai: null,
    ai_suggestion_id: null,
  };
}

function line(sender: "setter" | "prospect", text: string, extra: Partial<ScreenshotLine> = {}): ScreenshotLine {
  return { sender, text, confidence: "high", partial: false, ...extra };
}

// ---------------------------------------------------------------------------
// Not appending the same exchange twice
// ---------------------------------------------------------------------------

test("lines already in the thread are dropped", () => {
  // A screenshot nearly always includes the previous few messages for context.
  const existing = [message("setter", "hey, saw your last reel"), message("prospect", "thanks man")];
  const fresh = newLinesOnly(
    [line("setter", "hey, saw your last reel"), line("prospect", "thanks man"), line("prospect", "what do you do?")],
    existing,
  );
  assert.deepEqual(fresh.map((l) => l.text), ["what do you do?"]);
});

test("matching ignores case, spacing and a trailing full stop", () => {
  const existing = [message("prospect", "yeah I'm interested")];
  const fresh = newLinesOnly([line("prospect", "  Yeah I'm   interested. ")], existing);
  assert.deepEqual(fresh, []);
});

test("a line repeated inside one screenshot is only added once", () => {
  const fresh = newLinesOnly([line("prospect", "ok"), line("prospect", "ok")], []);
  assert.equal(fresh.length, 1);
});

test("a genuinely new message is kept even when it resembles an old one", () => {
  const existing = [message("prospect", "sounds good")];
  const fresh = newLinesOnly([line("prospect", "sounds good to me")], existing);
  assert.deepEqual(fresh.map((l) => l.text), ["sounds good to me"]);
});

test("empty lines never reach the thread", () => {
  assert.deepEqual(newLinesOnly([line("prospect", "   ")], []), []);
});

// ---------------------------------------------------------------------------
// Flagging a read the operator must look at
// ---------------------------------------------------------------------------

test("an unsure or cut-off line asks for review", () => {
  const base = { unreadable: [], looks_like_conversation: true, notes: null };
  assert.equal(needsReview({ ...base, lines: [line("prospect", "yes")] }), false);
  assert.equal(needsReview({ ...base, lines: [line("prospect", "yes", { confidence: "low" })] }), true);
  assert.equal(needsReview({ ...base, lines: [line("prospect", "yes", { partial: true })] }), true);
});

test("anything unreadable asks for review even when every line read cleanly", () => {
  assert.equal(
    needsReview({
      lines: [line("prospect", "yes")],
      unreadable: ["a message hidden behind the reaction bar"],
      looks_like_conversation: true,
      notes: null,
    }),
    true,
  );
});

// ---------------------------------------------------------------------------
// The last check before writing
// ---------------------------------------------------------------------------

test("confirmed lines are trimmed and kept in order", () => {
  const { ok, rejected } = validateLines([
    { sender: "setter", text: "  hey  " },
    { sender: "prospect", text: "hi" },
  ]);
  assert.deepEqual(ok.map((l) => [l.sender, l.text]), [["setter", "hey"], ["prospect", "hi"]]);
  assert.deepEqual(rejected, []);
});

test("empty text and unknown senders are rejected, not written", () => {
  const { ok, rejected } = validateLines([
    { sender: "prospect", text: "   " },
    { sender: "nobody", text: "injected" },
    { sender: "prospect", text: "real" },
  ]);
  assert.deepEqual(ok.map((l) => l.text), ["real"]);
  assert.deepEqual(rejected.map((r) => r.reason), ["empty", 'unknown sender "nobody"']);
});

test("the operator's correction is what is written, not the model's confidence in it", () => {
  // The preview lets a low-confidence line be reworded; what arrives here is the
  // operator's text, so it is stored as confirmed.
  const { ok } = validateLines([{ sender: "prospect", text: "I run a barbershop" }]);
  assert.equal(ok[0].confidence, "high");
  assert.equal(ok[0].partial, false);
});

// ---------------------------------------------------------------------------
// Sheet links
// ---------------------------------------------------------------------------

test("a Sheets URL yields the spreadsheet and tab", () => {
  assert.deepEqual(parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC-dEf_123456789012345/edit#gid=884422"), {
    spreadsheetId: "1AbC-dEf_123456789012345",
    gid: "884422",
  });
});

test("a link without a tab still resolves, and a bare id is accepted", () => {
  assert.deepEqual(parseSheetUrl("https://docs.google.com/spreadsheets/d/1AbC-dEf_123456789012345/edit"), {
    spreadsheetId: "1AbC-dEf_123456789012345",
    gid: null,
  });
  assert.deepEqual(parseSheetUrl("  1AbC-dEf_123456789012345  "), {
    spreadsheetId: "1AbC-dEf_123456789012345",
    gid: null,
  });
});

test("anything that is not a sheet is refused rather than guessed at", () => {
  assert.equal(parseSheetUrl(""), null);
  assert.equal(parseSheetUrl("https://example.com/some/page"), null);
  assert.equal(parseSheetUrl("my leads"), null);
});
