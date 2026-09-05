import type { LeadListItem } from "@/lib/types";

/**
 * Triage rules for the inbox, shared by the desktop sidebar and the mobile home
 * screen so the two can never disagree about what "needs reply" means.
 *
 * Pure functions, so the ordering the operator depends on is testable without a
 * browser.
 */

export const LEAD_FILTERS = ["all", "needs_reply", "followup_due", "high_priority", "call_ready"] as const;
export type LeadFilter = (typeof LEAD_FILTERS)[number];

export const FILTER_LABELS: Record<LeadFilter, string> = {
  all: "All",
  needs_reply: "Needs reply",
  followup_due: "Follow-up due",
  high_priority: "Warm",
  call_ready: "Call ready",
};

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

/** A thread we sent last and have heard nothing back on for this long is due. */
export const SILENT_DAYS_BEFORE_DUE = 3;

/** Messages either way before a thread counts as a conversation rather than a pitch. */
export const DEPTH_FOR_WARM = 4;

/**
 * Due a follow-up.
 *
 * A date set by hand still wins, but almost none ever are: keeping follow-up
 * dates is exactly the CRM bookkeeping this app exists to avoid, and a filter
 * that only works when the operator maintains it is a filter that is always
 * empty. So the thread answers it instead — we spoke last, and they have not
 * come back — which is the same judgement made without anyone typing it.
 */
export function isDue(lead: LeadListItem, now = Date.now()): boolean {
  if (lead.followup_status === "overdue" || lead.followup_status === "owed_reply") return true;
  if (lead.next_followup_at) return new Date(lead.next_followup_at).getTime() <= now;

  // Nothing set by hand: read it off the conversation.
  if (lead.awaiting_reply || lead.last_message_sender !== "setter" || !lead.last_message_at) return false;
  const silentDays = (now - new Date(lead.last_message_at).getTime()) / 86_400_000;
  return silentDays >= SILENT_DAYS_BEFORE_DUE;
}

/**
 * Worth the operator's attention next.
 *
 * `priority` and `interest_level` are set by hand and nothing in the pipeline
 * ever writes them, so on their own this filter stays empty forever. Depth is
 * the signal that costs nothing: a thread several messages deep is a
 * conversation someone is actually having, which a cold handle with an
 * unanswered opener is not.
 */
export function isWarm(lead: LeadListItem): boolean {
  if (lead.priority === "high" || lead.priority === "urgent" || lead.interest_level === "high") return true;
  if (lead.booked_call) return true;
  return lead.message_count >= DEPTH_FOR_WARM;
}

export function isCallReady(lead: LeadListItem): boolean {
  return Boolean(lead.booked_call) || /call[_ ]?ready|discovery/i.test(lead.conversation_stage ?? "");
}

export function matchesFilter(lead: LeadListItem, filter: LeadFilter): boolean {
  switch (filter) {
    case "needs_reply":
      return lead.awaiting_reply;
    case "followup_due":
      return isDue(lead);
    case "high_priority":
      return isWarm(lead);
    case "call_ready":
      return isCallReady(lead);
    default:
      return true;
  }
}

/**
 * Matches a search box against the handle first.
 *
 * The phone workflow is: read a reply in Instagram, switch over, type the first
 * few characters of the handle. A prefix match on the handle therefore outranks
 * a match buried in a company name.
 */
export function matchesQuery(lead: LeadListItem, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return true;
  return [lead.instagram_handle, lead.name, lead.company, lead.niche, lead.outbound_account_handle]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function searchRank(lead: LeadListItem, query: string): number {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return 2;
  const handle = lead.instagram_handle.toLowerCase();
  if (handle.startsWith(q)) return 0;
  if ((lead.name ?? "").toLowerCase().startsWith(q)) return 1;
  return 2;
}

export type FilterOptions = {
  filter?: LeadFilter;
  query?: string;
  /** `undefined` for every account, `null` for conversations with no account. */
  accountId?: string | null;
};

/**
 * The inbox, filtered and ordered so the work that needs doing is at the top.
 *
 * Threads waiting on us come first — those are the ones where a reply is
 * actually owed — then priority, then recency.
 */
export function filterLeads(leads: LeadListItem[], options: FilterOptions = {}): LeadListItem[] {
  const { filter = "all", query = "", accountId } = options;

  return leads
    .filter((lead) => {
      if (accountId !== undefined && (lead.outbound_account_id ?? null) !== accountId) return false;
      if (!matchesFilter(lead, filter)) return false;
      return matchesQuery(lead, query);
    })
    .sort((a, b) => {
      const ra = searchRank(a, query);
      const rb = searchRank(b, query);
      if (ra !== rb) return ra - rb;
      if (a.awaiting_reply !== b.awaiting_reply) return a.awaiting_reply ? -1 : 1;
      const pa = PRIORITY_RANK[a.priority ?? "medium"];
      const pb = PRIORITY_RANK[b.priority ?? "medium"];
      if (pa !== pb) return pa - pb;
      return (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
    });
}

export function filterCounts(leads: LeadListItem[], accountId?: string | null): Record<LeadFilter, number> {
  const scoped = accountId === undefined ? leads : leads.filter((l) => (l.outbound_account_id ?? null) === accountId);
  return {
    all: scoped.length,
    needs_reply: scoped.filter((l) => l.awaiting_reply).length,
    // Called with one argument deliberately: Array.filter passes the index as
    // the second, which `isDue` would read as `now`.
    followup_due: scoped.filter((l) => isDue(l)).length,
    high_priority: scoped.filter((l) => isWarm(l)).length,
    call_ready: scoped.filter((l) => isCallReady(l)).length,
  };
}
