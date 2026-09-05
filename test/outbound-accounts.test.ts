import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountLabel, checkDuplicateOutreach, isLegacyAccount, normaliseHandle } from "@/core/accounts";
import { funnelByAccount, leadFunnel } from "@/core/funnel";
import { runSetterForLead, recordExchange, type AgentDeps } from "@/core/agent";
import { offlineLlm } from "@/core/offline-llm";
import { LocalStore } from "@/lib/store/local-store";
import { LEGACY_ACCOUNT_HANDLE } from "@/lib/types";
import type { Lead, Message, OutboundAccount } from "@/lib/types";

/**
 * Outbound account attribution.
 *
 * Everything here is synthetic. The rule being tested throughout is that two
 * conversations with the same prospect from two different pages are two
 * conversations — never one.
 */

async function freshStore(): Promise<LocalStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dm-setter-accounts-"));
  return new LocalStore(dir);
}

function deps(store: LocalStore): AgentDeps {
  return { store, llm: offlineLlm, voiceSetter: "Cassey" };
}

async function twoAccounts(store: LocalStore) {
  const one = await store.createOutboundAccount({ handle: "page_one", display_name: "Page One" });
  const two = await store.createOutboundAccount({ handle: "page_two", display_name: "Page Two" });
  return { one, two };
}

// ---------------------------------------------------------------------------
// Accounts exist and leads are attributed
// ---------------------------------------------------------------------------

test("two outbound accounts can exist side by side", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const accounts = await store.listOutboundAccounts();
  assert.ok(accounts.some((a) => a.id === one.id));
  assert.ok(accounts.some((a) => a.id === two.id));
  assert.notEqual(one.id, two.id);

  await assert.rejects(() => store.createOutboundAccount({ handle: "@Page_One" }), /already an outbound account/i);
});

test("an account handle is stored normalised", async () => {
  const store = await freshStore();
  const account = await store.createOutboundAccount({ handle: "@New.Page" });
  assert.equal(account.handle, "new.page");
  assert.equal(normaliseHandle("@SomeOne"), "someone");
});

test("leads are attributed to the account that is talking to them", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const first = await store.createLead({ instagram_handle: "prospect_a", outbound_account_id: one.id });
  const second = await store.createLead({ instagram_handle: "prospect_b", outbound_account_id: two.id });

  assert.equal((await store.getLead(first.id))!.outbound_account_id, one.id);
  assert.equal((await store.getLead(second.id))!.outbound_account_id, two.id);
});

test("historical conversations get an explicit unknown account, never a guess", async () => {
  const store = await freshStore();
  const legacy = await store.legacyOutboundAccount();

  assert.equal(legacy.handle, LEGACY_ACCOUNT_HANDLE);
  assert.equal(legacy.active, false, "nothing is ever sent from 'we do not know'");
  assert.ok(isLegacyAccount(legacy));
  assert.match(accountLabel(legacy), /unknown|legacy/i);

  // Asking twice returns the same row rather than creating a second one.
  const again = await store.legacyOutboundAccount();
  assert.equal(again.id, legacy.id);
  const all = await store.listOutboundAccounts({ includeInactive: true });
  assert.equal(all.filter((a) => isLegacyAccount(a)).length, 1);
  assert.ok(!(await store.listOutboundAccounts()).some((a) => a.id === legacy.id), "and it is not offered for new outreach");
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test("the inbox can be filtered to one outbound account", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  await store.createLead({ instagram_handle: "a_one", outbound_account_id: one.id });
  await store.createLead({ instagram_handle: "b_one", outbound_account_id: one.id });
  await store.createLead({ instagram_handle: "c_two", outbound_account_id: two.id });
  await store.createLead({ instagram_handle: "d_none" });

  // The local store seeds a small demo workspace, so this asserts against what
  // the test created rather than against an empty database.
  const all = await store.listLeads();
  const forOne = await store.listLeads({ accountId: one.id });
  const forTwo = await store.listLeads({ accountId: two.id });
  const unattributed = await store.listLeads({ accountId: null });

  assert.ok(all.length >= 4);
  assert.ok(all.length > forOne.length + forTwo.length, "the unfiltered inbox includes other accounts' leads");
  assert.deepEqual(forOne.map((l) => l.instagram_handle).sort(), ["a_one", "b_one"]);
  assert.deepEqual(forTwo.map((l) => l.instagram_handle), ["c_two"]);
  assert.deepEqual(unattributed.map((l) => l.instagram_handle), ["d_none"]);
});

test("the inbox carries the account label so it can be shown without a lookup", async () => {
  const store = await freshStore();
  const { one } = await twoAccounts(store);
  await store.createLead({ instagram_handle: "labelled", outbound_account_id: one.id });

  const [lead] = await store.listLeads({ accountId: one.id });
  assert.equal(lead.outbound_account_handle, "page_one");
  assert.equal(lead.outbound_account_name, "Page One");
});

// ---------------------------------------------------------------------------
// Duplicate outreach
// ---------------------------------------------------------------------------

function leadRow(handle: string, accountId: string | null, overrides: Partial<Lead> = {}): Lead {
  return {
    id: `lead_${handle}_${accountId ?? "none"}`,
    instagram_handle: handle,
    outbound_account_id: accountId,
    name: null,
    company: null,
    job_title: null,
    industry: null,
    niche: null,
    followers: null,
    location: null,
    lead_status: "active",
    interest_level: null,
    conversation_stage: "DISCOVERY",
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
    created_at: null,
    updated_at: null,
    ...overrides,
  };
}

function account(id: string, handle: string, active = true): OutboundAccount {
  return { id, platform: "instagram", handle, display_name: handle, active, notes: null, created_at: "" };
}

test("the same prospect under another active account is a warning, not a block", () => {
  const accounts = [account("a1", "page_one"), account("a2", "page_two")];
  const warning = checkDuplicateOutreach({
    handle: "sameprospect",
    accountId: "a2",
    existing: [leadRow("sameprospect", "a1")],
    accounts,
  });

  assert.equal(warning.severity, "warn");
  assert.equal(warning.can_proceed, true, "there are legitimate reasons, so it is never silently blocked");
  assert.match(warning.message, /@page_one/);
  assert.match(warning.message, /spam/i);
  assert.equal(warning.matches[0].account_handle, "page_one");
  assert.equal(warning.matches[0].same_account, false);
});

test("the same prospect on the SAME account is one conversation and is refused", () => {
  const warning = checkDuplicateOutreach({
    handle: "sameprospect",
    accountId: "a1",
    existing: [leadRow("sameprospect", "a1")],
    accounts: [account("a1", "page_one")],
  });

  assert.equal(warning.severity, "blocked");
  assert.equal(warning.can_proceed, false);
  assert.match(warning.message, /already in the pipeline on this account/i);
});

test("a duplicate under a retired account is flagged more softly", () => {
  const warning = checkDuplicateOutreach({
    handle: "sameprospect",
    accountId: "a2",
    existing: [leadRow("sameprospect", "a1")],
    accounts: [account("a1", "page_one", false), account("a2", "page_two")],
  });

  assert.equal(warning.severity, "warn");
  assert.equal(warning.can_proceed, true);
  assert.match(warning.message, /inactive/i);
});

test("a new prospect produces no warning at all", () => {
  const warning = checkDuplicateOutreach({
    handle: "brand_new",
    accountId: "a1",
    existing: [leadRow("someone_else", "a1")],
    accounts: [account("a1", "page_one")],
  });

  assert.equal(warning.severity, "none");
  assert.deepEqual(warning.matches, []);
});

test("the duplicate check is case-insensitive and ignores a leading @", () => {
  const warning = checkDuplicateOutreach({
    handle: "@SameProspect",
    accountId: "a2",
    existing: [leadRow("sameprospect", "a1")],
    accounts: [account("a1", "page_one"), account("a2", "page_two")],
  });
  assert.equal(warning.severity, "warn");
});

// ---------------------------------------------------------------------------
// Nothing crosses an account boundary
// ---------------------------------------------------------------------------

test("two threads with the same prospect keep separate messages and memory", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const first = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: one.id });
  const second = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: two.id });
  assert.notEqual(first.id, second.id);

  await store.appendMessages(first.id, [
    { sender: "setter", message_text: "Hey — what are you building toward?" },
    { sender: "prospect", message_text: "I'm launching a supplement brand in Q1" },
  ]);
  await store.appendMessages(second.id, [{ sender: "setter", message_text: "Different page, different opener." }]);

  await store.upsertMemory(first.id, { lead_id: first.id, current_strategy: "Page one strategy" });

  const firstMessages = await store.listMessages(first.id);
  const secondMessages = await store.listMessages(second.id);

  assert.equal(firstMessages.length, 2);
  assert.equal(secondMessages.length, 1);
  assert.ok(!secondMessages.some((m: Message) => /supplement brand/.test(m.message_text)));

  assert.equal((await store.getMemory(first.id))?.current_strategy, "Page one strategy");
  assert.equal((await store.getMemory(second.id))?.current_strategy ?? null, null, "memory does not leak across pages");
});

test("a handle lookup returns the thread for the account being asked about", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const first = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: one.id });
  const second = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: two.id });

  assert.equal((await store.getLeadByHandle("sameprospect", { accountId: one.id }))!.id, first.id);
  assert.equal((await store.getLeadByHandle("sameprospect", { accountId: two.id }))!.id, second.id);
  assert.equal((await store.findLeadsByHandle("sameprospect")).length, 2);
});

test("the pipeline reads only the thread it was asked about", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const first = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: one.id });
  const second = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: two.id });

  await store.appendMessages(first.id, [
    { sender: "setter", message_text: "What are you building toward?" },
    { sender: "prospect", message_text: "I'm launching SkyMD, a telehealth product, in Q1" },
  ]);
  await store.appendMessages(second.id, [{ sender: "setter", message_text: "Hey — quick thought on your clinic." }]);

  const result = await runSetterForLead(second.id, "who is this?", deps(store));

  assert.ok(
    !/skymd/i.test(JSON.stringify(result)),
    "nothing the prospect said to the other page may appear in this one's suggestion",
  );
  assert.equal(result.read.already_answered.length, 0, "and nothing is treated as already answered here");
});

test("memory written on one account's thread never reaches the other", async () => {
  const store = await freshStore();
  const { one, two } = await twoAccounts(store);

  const first = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: one.id });
  const second = await store.createLead({ instagram_handle: "sameprospect", outbound_account_id: two.id });

  await store.appendMessages(first.id, [{ sender: "prospect", message_text: "how much do you charge?" }]);
  const generated = await runSetterForLead(first.id, "", deps(store));
  await recordExchange(store, first.id, generated.strategy, "We work with clients on media and search presence.");

  const memoryOne = await store.getMemory(first.id);
  const memoryTwo = await store.getMemory(second.id);

  assert.ok((memoryOne?.questions_already_asked?.length ?? 0) >= 0);
  assert.equal(memoryOne?.service_explained, true);
  assert.equal(memoryTwo, null, "the other page's thread has no memory at all yet");
});

// ---------------------------------------------------------------------------
// Analytics segment by account
// ---------------------------------------------------------------------------

function message(sender: Message["sender"], text: string, i: number, leadId: string): Message {
  return {
    id: `${leadId}_m${i}`,
    lead_id: leadId,
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

test("the funnel segments by outbound account", () => {
  const accounts = [
    { id: "a1", handle: "page_one", display_name: "Page One", active: true },
    { id: "a2", handle: "page_two", display_name: "Page Two", active: true },
  ];

  const rows = [
    // Page one: two conversations, one replied and booked, one silent.
    leadFunnel({
      lead: leadRow("replied", "a1", { id: "l1", booked_call: true, outcome: "Onboarding" }),
      messages: [
        message("setter", "Hey — what are you building toward?", 0, "l1"),
        message("prospect", "launching in Q1, sounds interesting — how much do you charge?", 1, "l1"),
      ],
      memory: null,
    }),
    leadFunnel({
      lead: leadRow("silent", "a1", { id: "l2" }),
      messages: [message("setter", "Hey — quick thought on the clinic.", 0, "l2")],
      memory: null,
    }),
    // Page two: one conversation that replied and went nowhere.
    leadFunnel({
      lead: leadRow("cold", "a2", { id: "l3", outcome: "Not interested" }),
      messages: [
        message("setter", "Hey — noticed the launch.", 0, "l3"),
        message("prospect", "not interested at all, please stop messaging me", 1, "l3"),
      ],
      memory: null,
    }),
  ];

  const funnels = funnelByAccount(rows, accounts);
  const one = funnels.find((f) => f.account_id === "a1")!;
  const two = funnels.find((f) => f.account_id === "a2")!;

  assert.equal(one.counts.dms_sent, 2);
  assert.equal(one.counts.conversations, 2);
  assert.equal(one.counts.replies, 1);
  assert.equal(one.counts.positive_replies, 1);
  assert.equal(one.counts.calls_booked, 1);
  assert.equal(one.counts.onboardings, 1);
  assert.equal(one.counts.shows, 1, "an onboarding implies the call happened");
  assert.equal(one.rates.reply_rate, 0.5);

  assert.equal(two.counts.replies, 1);
  assert.equal(two.counts.positive_replies, 0, "an explicit refusal is not a positive reply");
  assert.equal(two.counts.not_interested, 1);
  assert.equal(two.counts.calls_booked, 0);
});

test("an account with no leads still appears, and unattributed leads are not hidden", () => {
  const accounts = [
    { id: "a1", handle: "page_one", display_name: null, active: true },
    { id: "a2", handle: "page_two", display_name: null, active: true },
  ];
  const rows = [
    leadFunnel({
      lead: leadRow("orphan", null, { id: "l9" }),
      messages: [message("setter", "hello", 0, "l9")],
      memory: null,
    }),
  ];

  const funnels = funnelByAccount(rows, accounts);
  assert.equal(funnels.length, 3, "both accounts plus the unattributed bucket");
  const unattributed = funnels.find((f) => f.account_id === null)!;
  assert.equal(unattributed.counts.dms_sent, 1);
  assert.equal(funnels.find((f) => f.account_id === "a2")!.counts.dms_sent, 0);
});

test("conversion rates are null rather than zero when nothing has happened yet", () => {
  const funnels = funnelByAccount([], [{ id: "a1", handle: "page_one", display_name: null, active: true }]);
  assert.equal(funnels[0].rates.reply_rate, null);
  assert.equal(funnels[0].rates.booking_rate, null);
});
