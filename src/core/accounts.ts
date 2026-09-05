import type { Lead, OutboundAccount } from "@/lib/types";
import { LEGACY_ACCOUNT_HANDLE } from "@/lib/types";

/**
 * Outbound account attribution.
 *
 * Outreach runs from several Instagram pages. Which page a conversation belongs
 * to is not cosmetic: two threads with the same prospect from two pages are two
 * separate conversations with separate memory, and merging them would have the
 * setter refer to things that were said to someone else, from an account that
 * never said them.
 *
 * This module is attribution only. There is nothing here about logging into
 * Instagram or sending anything: the operator sends, and records which account
 * they sent from.
 */

export function normaliseHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/** True for the account historical conversations are attributed to. */
export function isLegacyAccount(account: Pick<OutboundAccount, "handle"> | null | undefined): boolean {
  return normaliseHandle(account?.handle ?? "") === LEGACY_ACCOUNT_HANDLE;
}

export function accountLabel(account: OutboundAccount | null | undefined): string {
  if (!account) return "Unattributed";
  if (isLegacyAccount(account)) return LEGACY_ACCOUNT_HANDLE === account.handle ? "Unknown / legacy" : account.handle;
  return account.display_name?.trim() || `@${account.handle}`;
}

// ---------------------------------------------------------------------------
// Duplicate outreach
// ---------------------------------------------------------------------------

export type DuplicateMatch = {
  lead_id: string;
  handle: string;
  account_id: string | null;
  account_handle: string | null;
  account_active: boolean;
  /** True when this is the same prospect on the same account — a real duplicate. */
  same_account: boolean;
  last_contact_at: string | null;
  conversation_stage: string | null;
  message_count?: number;
};

export type DuplicateWarning = {
  /** "blocked" — already in the pipeline on this same account. */
  severity: "blocked" | "warn" | "none";
  message: string;
  matches: DuplicateMatch[];
  /** True when the operator may proceed by acknowledging it. */
  can_proceed: boolean;
};

/**
 * Checks whether this prospect is already being contacted, and from where.
 *
 * Two different accounts messaging the same person is not automatically wrong —
 * a personal page and a brand page can legitimately both reach out, and a lead
 * that went cold on one may be re-approached from another. It is, however,
 * always something the operator should know before it happens, so the same
 * prospect never receives two identical openers in a week from two pages.
 *
 * The same account contacting the same prospect twice is a different thing: that
 * is one conversation, and it already exists.
 */
export function checkDuplicateOutreach(input: {
  handle: string;
  accountId: string | null;
  existing: (Lead & { message_count?: number })[];
  accounts: OutboundAccount[];
}): DuplicateWarning {
  const handle = normaliseHandle(input.handle);
  const byId = new Map(input.accounts.map((a) => [a.id, a]));

  const matches: DuplicateMatch[] = input.existing
    .filter((lead) => normaliseHandle(lead.instagram_handle) === handle)
    .map((lead) => {
      const account = lead.outbound_account_id ? byId.get(lead.outbound_account_id) ?? null : null;
      return {
        lead_id: lead.id,
        handle: lead.instagram_handle,
        account_id: lead.outbound_account_id,
        account_handle: account?.handle ?? null,
        account_active: account?.active ?? false,
        same_account: Boolean(input.accountId) && lead.outbound_account_id === input.accountId,
        last_contact_at: lead.last_contact_at,
        conversation_stage: lead.conversation_stage,
        message_count: lead.message_count,
      };
    });

  if (matches.length === 0) {
    return { severity: "none", message: "", matches: [], can_proceed: true };
  }

  const sameAccount = matches.find((m) => m.same_account);
  if (sameAccount) {
    return {
      severity: "blocked",
      message: `@${handle} is already in the pipeline on this account. Open the existing conversation rather than starting a second one.`,
      matches,
      can_proceed: false,
    };
  }

  // Only live accounts matter for accidental double outreach: a lead sitting
  // under a retired page is history, not a message about to be sent twice.
  const active = matches.filter((m) => m.account_active);
  if (active.length === 0) {
    return {
      severity: "warn",
      message: `@${handle} exists under ${matches.length === 1 ? "an inactive account" : "inactive accounts"} (${matches
        .map((m) => (m.account_handle ? `@${m.account_handle}` : "unattributed"))
        .join(", ")}). Nothing is being sent from there, but the history is worth reading first.`,
      matches,
      can_proceed: true,
    };
  }

  return {
    severity: "warn",
    message: `@${handle} is already being contacted from ${active
      .map((m) => `@${m.account_handle}`)
      .join(" and ")}. Two of our pages messaging the same person at once reads as spam — check that thread before starting another.`,
    matches,
    can_proceed: true,
  };
}
