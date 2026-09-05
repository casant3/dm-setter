import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FILTER_LABELS,
  LEAD_FILTERS,
  filterCounts,
  filterLeads,
  isCallReady,
  isDue,
  isWarm,
  matchesQuery,
} from "@/components/lead-filters";
import type { LeadListItem } from "@/lib/types";

/**
 * Inbox triage.
 *
 * The phone workflow is: a reply arrives in Instagram, the operator switches
 * over, types the first characters of the handle and opens the thread. These
 * tests cover the ordering and filtering that has to be right for that to be
 * one gesture, without needing a browser.
 */

function lead(overrides: Partial<LeadListItem> & { instagram_handle: string }): LeadListItem {
  return {
    id: `lead_${overrides.instagram_handle}`,
    outbound_account_id: null,
    outbound_account_handle: null,
    outbound_account_name: null,
    name: null,
    company: null,
    job_title: null,
    industry: null,
    niche: null,
    followers: null,
    location: null,
    lead_status: "active",
    interest_level: null,
    conversation_stage: null,
    priority: "medium",
    media_experience: null,
    authority_level: null,
    media_gap: null,
    commercial_goal: null,
    first_contact_at: null,
    last_contact_at: null,
    next_followup_at: null,
    followup_status: null,
    followup_note: null,
    booked_call: null,
    booked_call_at: null,
    outcome: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    message_count: 2,
    last_message_at: "2026-01-01T00:00:00.000Z",
    last_message_preview: null,
    last_message_sender: "setter",
    awaiting_reply: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// What surfaces first
// ---------------------------------------------------------------------------

test("threads waiting on a reply come first, then priority, then recency", () => {
  const leads = [
    lead({ instagram_handle: "quiet", last_message_at: "2026-02-01T00:00:00.000Z" }),
    lead({ instagram_handle: "urgent_waiting", awaiting_reply: true, priority: "low", last_message_at: "2026-01-01T00:00:00.000Z" }),
    lead({ instagram_handle: "warm", priority: "urgent", last_message_at: "2026-01-05T00:00:00.000Z" }),
  ];

  assert.deepEqual(
    filterLeads(leads).map((l) => l.instagram_handle),
    ["urgent_waiting", "warm", "quiet"],
  );
});

test("a handle prefix outranks a match buried in a company name", () => {
  const leads = [
    lead({ instagram_handle: "someone", company: "Cody Industries", awaiting_reply: true }),
    lead({ instagram_handle: "codyalt", name: "Cody Alton" }),
  ];

  assert.deepEqual(
    filterLeads(leads, { query: "cody" }).map((l) => l.instagram_handle),
    ["codyalt", "someone"],
    "typing the handle finds the handle, even when another thread is waiting",
  );
});

test("search ignores a leading @ and casing", () => {
  const l = lead({ instagram_handle: "codyalt", name: "Cody Alton" });
  assert.ok(matchesQuery(l, "@Cody"));
  assert.ok(matchesQuery(l, "CODYALT"));
  assert.ok(matchesQuery(l, ""));
  assert.ok(!matchesQuery(l, "nobody"));
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const JUST_NOW = new Date().toISOString();

test("each filter selects what it says it does", () => {
  // Everything here was messaged just now, so nothing falls into the derived
  // cases below and each filter is tested on the field it is named for.
  const fresh = { last_message_at: JUST_NOW, message_count: 1 };
  const waiting = lead({ instagram_handle: "waiting", awaiting_reply: true, last_message_sender: "prospect", ...fresh });
  const due = lead({ instagram_handle: "due", followup_status: "overdue", ...fresh });
  const warm = lead({ instagram_handle: "warm", priority: "high", ...fresh });
  const ready = lead({ instagram_handle: "ready", conversation_stage: "CALL_READY", ...fresh });
  const cold = lead({ instagram_handle: "cold", ...fresh });
  const leads = [waiting, due, warm, ready, cold];

  assert.deepEqual(filterLeads(leads, { filter: "needs_reply" }).map((l) => l.instagram_handle), ["waiting"]);
  assert.deepEqual(filterLeads(leads, { filter: "followup_due" }).map((l) => l.instagram_handle), ["due"]);
  assert.deepEqual(filterLeads(leads, { filter: "high_priority" }).map((l) => l.instagram_handle), ["warm"]);
  assert.deepEqual(filterLeads(leads, { filter: "call_ready" }).map((l) => l.instagram_handle), ["ready"]);
  assert.equal(filterLeads(leads, { filter: "all" }).length, 5);

  assert.ok(isDue(due) && !isDue(cold));
  assert.ok(isWarm(warm) && !isWarm(cold));
  assert.ok(isCallReady(ready) && !isCallReady(cold));
  assert.ok(isCallReady(lead({ instagram_handle: "booked", booked_call: true })));
});

// ---------------------------------------------------------------------------
// Triage without bookkeeping
//
// `priority`, `interest_level`, `followup_status` and `next_followup_at` are
// set by hand and nothing in the pipeline writes them. Two of the five filters
// used to read only those, so they were empty unless the operator kept a CRM up
// to date. These cover the signals that now stand in, taken from the thread.
// ---------------------------------------------------------------------------

const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

test("a thread we sent last and heard nothing on becomes due on its own", () => {
  const silent = lead({
    instagram_handle: "silent",
    last_message_sender: "setter",
    last_message_at: days(4),
    awaiting_reply: false,
  });
  assert.equal(isDue(silent), true, "four days of silence after our message is a follow-up");

  const yesterday = lead({
    instagram_handle: "yesterday",
    last_message_sender: "setter",
    last_message_at: days(1),
    awaiting_reply: false,
  });
  assert.equal(isDue(yesterday), false, "one day is not yet a follow-up");
});

test("a thread waiting on us is never also a follow-up", () => {
  // They replied and we have not answered. That is "needs reply", not chasing.
  const theirTurn = lead({
    instagram_handle: "theirs",
    awaiting_reply: true,
    last_message_sender: "prospect",
    last_message_at: days(9),
  });
  assert.equal(isDue(theirTurn), false);
});

test("a date set by hand still decides, in both directions", () => {
  const silentButScheduled = lead({
    instagram_handle: "scheduled",
    last_message_sender: "setter",
    last_message_at: days(30),
    next_followup_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.equal(isDue(silentButScheduled), false, "an explicit future date beats the silence rule");
});

test("a real back-and-forth counts as warm without anyone tagging it", () => {
  const conversation = lead({ instagram_handle: "talking", message_count: 6, priority: "medium" });
  assert.equal(isWarm(conversation), true);

  const unanswered = lead({ instagram_handle: "opener", message_count: 1, priority: "medium" });
  assert.equal(isWarm(unanswered), false, "an unanswered opener is not a warm lead");
});

test("the chip count agrees with the list it filters", () => {
  // `isDue` takes an optional `now`, and Array.filter passes the index as its
  // second argument — so counting with a bare `filter(isDue)` silently dated
  // every lead to the epoch and the counts disagreed with the rows.
  const leads = [
    lead({ instagram_handle: "silent_a", last_message_sender: "setter", last_message_at: days(5) }),
    lead({ instagram_handle: "silent_b", last_message_sender: "setter", last_message_at: days(6) }),
    lead({ instagram_handle: "silent_c", last_message_sender: "setter", last_message_at: days(7) }),
    lead({ instagram_handle: "waiting", awaiting_reply: true, last_message_sender: "prospect", last_message_at: days(2) }),
  ];
  const counts = filterCounts(leads);
  for (const key of LEAD_FILTERS) {
    assert.equal(counts[key], filterLeads(leads, { filter: key }).length, `count for "${key}" matches its rows`);
  }
  assert.equal(counts.followup_due, 3);
});

test("a booked call is warm regardless of depth or tagging", () => {
  assert.equal(isWarm(lead({ instagram_handle: "booked", message_count: 2, booked_call: true })), true);
});

test("a follow-up dated in the future is not yet due", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  assert.equal(isDue(lead({ instagram_handle: "later", next_followup_at: future })), false);
  assert.equal(isDue(lead({ instagram_handle: "now", next_followup_at: past })), true);
});

test("every filter has a label", () => {
  for (const key of LEAD_FILTERS) assert.ok(FILTER_LABELS[key].length > 0);
});

// ---------------------------------------------------------------------------
// Account scoping — the same rules the mobile tabs use
// ---------------------------------------------------------------------------

const PAGE_ONE = [
  lead({ instagram_handle: "a_one", outbound_account_id: "a1", outbound_account_handle: "page_one", awaiting_reply: true }),
  lead({ instagram_handle: "b_one", outbound_account_id: "a1", outbound_account_handle: "page_one" }),
];
const PAGE_TWO = [
  lead({ instagram_handle: "c_two", outbound_account_id: "a2", outbound_account_handle: "page_two", awaiting_reply: true }),
];
const UNATTRIBUTED = [lead({ instagram_handle: "d_none" })];
const ALL = [...PAGE_ONE, ...PAGE_TWO, ...UNATTRIBUTED];

test("the account tab scopes the inbox", () => {
  assert.deepEqual(filterLeads(ALL, { accountId: "a1" }).map((l) => l.instagram_handle), ["a_one", "b_one"]);
  assert.deepEqual(filterLeads(ALL, { accountId: "a2" }).map((l) => l.instagram_handle), ["c_two"]);
  assert.deepEqual(filterLeads(ALL, { accountId: null }).map((l) => l.instagram_handle), ["d_none"]);
  assert.equal(filterLeads(ALL).length, 4, "no account selected means every account");
});

test("counts follow the selected account, so the chips never lie", () => {
  assert.equal(filterCounts(ALL).needs_reply, 2);
  assert.equal(filterCounts(ALL, "a1").needs_reply, 1);
  assert.equal(filterCounts(ALL, "a1").all, 2);
  assert.equal(filterCounts(ALL, "a2").all, 1);
});

test("filtering by account and by state compose", () => {
  const result = filterLeads(ALL, { accountId: "a1", filter: "needs_reply" });
  assert.deepEqual(result.map((l) => l.instagram_handle), ["a_one"]);
});

test("searching inside one account cannot return another account's lead", () => {
  const result = filterLeads(ALL, { accountId: "a1", query: "c_two" });
  assert.deepEqual(result, [], "the other page's prospect is not reachable from this tab");
});

test("an account handle is searchable when every account is in view", () => {
  const result = filterLeads(ALL, { query: "page_two" });
  assert.deepEqual(result.map((l) => l.instagram_handle), ["c_two"]);
});
