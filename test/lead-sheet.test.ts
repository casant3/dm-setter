import assert from "node:assert/strict";
import { test } from "node:test";
import { dedupeCandidates, parseCell, parseDelimited, parseLeadSheet, parseRowDate } from "@/core/lead-sheet";

/**
 * Reading the lead vault grid.
 *
 * The fixtures mirror the real sheet's shape — day rows, block labels, status
 * headers, running totals, empty future days — with invented handles.
 */

test("a day row written without a year is dated into the year given", () => {
  // The sheet is filled in by hand and the year is obvious from the tab, so
  // "26/8" is what actually gets typed. Reading it as "not a date" would drop
  // the whole day's handles without saying so.
  assert.equal(parseRowDate("26/8", 2026), "2026-08-26T12:00:00.000Z");
  assert.equal(parseRowDate("27.8", 2026), "2026-08-27T12:00:00.000Z");
  assert.equal(parseRowDate(" 5 / 8 ", 2026), "2026-08-05T12:00:00.000Z");
});

test("the day comes first, matching the three-part form and the sheet's own wording", () => {
  assert.equal(parseRowDate("03/09/2026"), "2026-09-03T12:00:00.000Z");
  assert.equal(parseRowDate("3/9", 2026), "2026-09-03T12:00:00.000Z");
});

test("an impossible short date is refused rather than shifted into the next month", () => {
  assert.equal(parseRowDate("13/13", 2026), null);
  assert.equal(parseRowDate("32/8", 2026), null);
  assert.equal(parseRowDate("29/2", 2026), null);
});

test("a whole day of handles survives a year-less date row", () => {
  const parsed = parseLeadSheet(parseDelimited("26/8\tone_handle\ttwo.handle - coach"), { year: 2026 });
  assert.deepEqual(parsed.candidates.map((c) => c.instagram_handle), ["one_handle", "two.handle"]);
  assert.equal(parsed.candidates[0].dated_at, "2026-08-26T12:00:00.000Z");
  assert.equal(parsed.days, 1);
});

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

test("a plain handle is read as a handle", () => {
  // Shapes taken from the real sheet — a trailing digit, a stray @ and spaces,
  // an underscore escaped by the export — with invented handles.
  assert.deepEqual(parseCell("nordvale.7"), { handle: "nordvale.7", note: null });
  assert.deepEqual(parseCell("  @BrackenHollis  "), { handle: "brackenhollis", note: null });
  assert.deepEqual(parseCell("tarn\\_wilder"), { handle: "tarn_wilder", note: null });
});

test("a role written beside the handle is kept as a note", () => {
  assert.deepEqual(parseCell("benitoz - investor"), { handle: "benitoz", note: "investor" });
  assert.deepEqual(parseCell("st_snyder - business owner"), { handle: "st_snyder", note: "business owner" });
  assert.deepEqual(parseCell("kb_the_rockstar_ceo - founder 29/07"), {
    handle: "kb_the_rockstar_ceo",
    note: "founder 29/07",
  });
});

test("a remark in brackets is a note, not part of the handle", () => {
  const parsed = parseCell("martinvars ( private Instagram account and can not message)");
  assert.deepEqual(parsed, { handle: "martinvars", note: "private Instagram account and can not message" });
});

test("a sentence is skipped rather than turned into a prospect", () => {
  const parsed = parseCell("all warm leads on trello");
  assert.ok("reason" in parsed, "this is a note to self, not a lead");

  assert.ok("reason" in parseCell(""));
  assert.ok("reason" in parseCell("   "));
  assert.ok("reason" in parseCell("123"), "a bare number is a column index");
});

test("a carriage-return artefact does not corrupt the handle", () => {
  assert.deepEqual(parseCell("jamiermarsh&#13;"), { handle: "jamiermarsh", note: null });
});

// ---------------------------------------------------------------------------
// Row dates
// ---------------------------------------------------------------------------

test("the sheet's date formats are all understood", () => {
  assert.equal(parseRowDate("03/09/2026")?.slice(0, 10), "2026-09-03");
  assert.equal(parseRowDate("3/9/26")?.slice(0, 10), "2026-09-03");
  assert.equal(parseRowDate("22nd of July", 2026)?.slice(0, 10), "2026-07-22");
  assert.equal(parseRowDate("1th of August", 2026)?.slice(0, 10), "2026-08-01");
  assert.equal(parseRowDate("30/7/26")?.slice(0, 10), "2026-07-30");
});

test("structure and nonsense are not dates", () => {
  for (const label of ["Q3", "SuccessfulArcs", "TOTAL WARM = 26", "Date", "IG handle", "", "SENT"]) {
    assert.equal(parseRowDate(label), null, `"${label}" must not read as a day`);
  }
  assert.equal(parseRowDate("31/02/2026"), null, "an impossible day is not a date");
});

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

/** The real sheet's shape, with invented handles. */
const GRID: string[][] = [
  ["SENT", "", "", ""],
  ["OPENED", "WARM", "Info Packet Sent", "Discovery Call Booked"],
  ["[merged] @pageone / @pagetwo", "[merged] @pageone / @pagetwo", "(Add on Trello)", ""],
  ["", "1", "2", "3"],
  ["Date", "IG handle", "IG handle", "IG handle"],
  ["Q3", "", "", ""],
  ["PageOne", "", "", ""],
  ["20/07/2026", "firstlead", "secondlead - investor", "thirdlead"],
  ["21/07/2026", "fourthlead", "all warm leads on trello", "fifthlead - founder"],
  ["", "TOTAL WARM = 2", "TOTAL BOOKED CALLS = 1", ""],
  ["22/07/2026", "", "", ""],
  ["23/07/2026", "", "", ""],
];

test("day rows become leads and everything else is left alone", () => {
  const result = parseLeadSheet(GRID, { year: 2026 });

  assert.deepEqual(
    result.candidates.map((c) => c.instagram_handle),
    ["firstlead", "secondlead", "thirdlead", "fourthlead", "fifthlead"],
  );
  assert.equal(result.days, 2, "two days had leads");
  assert.equal(result.empty_days, 2, "two more days are waiting to be filled in");
  assert.deepEqual(result.blocks, ["PageOne"], "the block label is the sending page");
  assert.ok(result.candidates.every((c) => c.block === "PageOne"));
});

test("the date, note and position travel with each lead", () => {
  const [first, second] = parseLeadSheet(GRID, { year: 2026 }).candidates;

  assert.equal(first.instagram_handle, "firstlead");
  assert.equal(first.dated_at?.slice(0, 10), "2026-07-20");
  assert.equal(first.source_date, "20/07/2026");
  assert.equal(first.position, 1);
  assert.equal(first.note, null);

  assert.equal(second.note, "investor");
  assert.equal(second.position, 2);
  assert.equal(second.raw, "secondlead - investor", "the cell is kept verbatim for review");
});

test("cells that are not leads are reported rather than dropped silently", () => {
  const result = parseLeadSheet(GRID, { year: 2026 });

  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].raw, /all warm leads/);
  assert.equal(result.skipped[0].source_date, "21/07/2026");
});

test("status headers and totals never become prospects", () => {
  const handles = parseLeadSheet(GRID, { year: 2026 }).candidates.map((c) => c.instagram_handle);
  for (const junk of ["warm", "total", "ig", "handle", "date", "sent", "opened", "q3", "pageone"]) {
    assert.ok(!handles.includes(junk), `"${junk}" must not be imported as a lead`);
  }
});

test("a second block label re-attributes the rows beneath it", () => {
  const rows: string[][] = [
    ["PageOne", "", ""],
    ["20/07/2026", "leadone", "leadtwo"],
    ["PageTwo", "", ""],
    ["21/07/2026", "leadthree", ""],
  ];
  const result = parseLeadSheet(rows, { year: 2026 });

  assert.deepEqual(result.blocks, ["PageOne", "PageTwo"]);
  assert.deepEqual(
    result.candidates.map((c) => [c.instagram_handle, c.block]),
    [
      ["leadone", "PageOne"],
      ["leadtwo", "PageOne"],
      ["leadthree", "PageTwo"],
    ],
  );
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

test("a prospect repeated across status columns is imported once", () => {
  const rows: string[][] = [
    ["20/07/2026", "repeated", "unique_one"],
    ["21/07/2026", "repeated", "unique_two"],
  ];
  const { unique, duplicates } = dedupeCandidates(parseLeadSheet(rows, { year: 2026 }).candidates);

  assert.deepEqual(unique.map((c) => c.instagram_handle), ["repeated", "unique_one", "unique_two"]);
  assert.equal(duplicates, 1);
  assert.equal(unique[0].source_date, "20/07/2026", "the first sighting keeps its date");
});

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

test("CSV and pasted TSV are both read", () => {
  const csv = parseDelimited("20/07/2026,firstlead,secondlead\n21/07/2026,thirdlead,");
  assert.deepEqual(csv[0], ["20/07/2026", "firstlead", "secondlead"]);

  const tsv = parseDelimited("20/07/2026\tfirstlead\tsecondlead");
  assert.deepEqual(tsv[0], ["20/07/2026", "firstlead", "secondlead"]);
});

test("quoted cells containing commas survive", () => {
  const rows = parseDelimited('20/07/2026,"someone - founder, investor",other');
  assert.deepEqual(rows[0], ["20/07/2026", "someone - founder, investor", "other"]);
});

test("an escaped quote inside a cell is preserved", () => {
  const rows = parseDelimited('20/07/2026,"they said ""no"" twice"');
  assert.deepEqual(rows[0], ["20/07/2026", 'they said "no" twice']);
});

test("end to end, a pasted export produces reviewable candidates", () => {
  const pasted = [
    "Date,IG handle,IG handle,IG handle",
    "Q3,,,",
    "SuccessfulArcs,,,",
    "20/07/2026,alpha.one,beta_two - investor,gamma.three",
    ",TOTAL WARM = 1,,",
    "21/07/2026,delta_four,,",
    "22/07/2026,,,",
  ].join("\n");

  const result = parseLeadSheet(parseDelimited(pasted), { year: 2026 });
  assert.deepEqual(
    result.candidates.map((c) => c.instagram_handle),
    ["alpha.one", "beta_two", "gamma.three", "delta_four"],
  );
  assert.deepEqual(result.blocks, ["SuccessfulArcs"]);
  assert.equal(result.empty_days, 1);
});
