"use client";

import { useMemo, useState } from "react";
import type { LeadListItem, OutboundAccount } from "@/lib/types";
import { FOLLOWUP_LABELS, followupTone, priorityTone, relativeTime } from "@/components/format";
import { FILTER_LABELS, LEAD_FILTERS, filterCounts, filterLeads, type LeadFilter } from "@/components/lead-filters";

export function LeadsSidebar({
  leads,
  accounts,
  accountId,
  onAccountChange,
  selectedId,
  onSelect,
  onNewLead,
  loading,
}: {
  leads: LeadListItem[];
  accounts: OutboundAccount[];
  /** `undefined` = every account. */
  accountId: string | undefined;
  onAccountChange: (id: string | undefined) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewLead: () => void;
  loading: boolean;
}) {
  const [filter, setFilter] = useState<LeadFilter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => filterLeads(leads, { filter, query, accountId }), [leads, filter, query, accountId]);
  const counts = useMemo(() => filterCounts(leads, accountId), [leads, accountId]);

  return (
    <section className="column" aria-label="Leads">
      <div className="column-header">
        <span className="column-title">Leads</span>
        <span className="badge">{counts.all}</span>
        {counts.needs_reply > 0 && <span className="badge bad">{counts.needs_reply} awaiting</span>}
        <div className="spacer" style={{ flex: 1 }} />
        <button className="btn small primary" onClick={onNewLead}>
          + Lead
        </button>
      </div>

      <div style={{ padding: "0 14px 10px" }}>
        <input
          type="text"
          placeholder="Search name, handle, company…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: "100%" }}
          aria-label="Search leads"
        />
      </div>

      {accounts.length > 0 && (
        <div className="lead-filters" role="group" aria-label="Filter by outbound account">
          <button className="chip" aria-pressed={accountId === undefined} onClick={() => onAccountChange(undefined)}>
            All accounts
          </button>
          {accounts.map((account) => (
            <button
              key={account.id}
              className="chip"
              aria-pressed={accountId === account.id}
              onClick={() => onAccountChange(account.id)}
              title={account.display_name ?? account.handle}
            >
              @{account.handle}
            </button>
          ))}
        </div>
      )}

      <div className="lead-filters" role="group" aria-label="Filter leads">
        {LEAD_FILTERS.map((key) => (
          <button key={key} className="chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {FILTER_LABELS[key]}
            {key !== "all" && counts[key] > 0 ? ` (${counts[key]})` : ""}
          </button>
        ))}
      </div>

      <div className="column-body">
        {loading && leads.length === 0 && <p className="empty">Loading leads…</p>}
        {!loading && visible.length === 0 && (
          <p className="empty">{leads.length === 0 ? "No leads yet. Add one to get started." : "No leads match this filter."}</p>
        )}

        {visible.map((lead) => (
          <button
            key={lead.id}
            className="lead"
            aria-current={lead.id === selectedId}
            onClick={() => onSelect(lead.id)}
          >
            <div className="lead-top">
              {lead.awaiting_reply && <span className="dot" title="Waiting on your reply" />}
              <span className="lead-name">{lead.name ?? `@${lead.instagram_handle}`}</span>
              <span className="lead-handle">@{lead.instagram_handle}</span>
              <span style={{ flex: 1 }} />
              <span className="lead-handle">{relativeTime(lead.last_message_at)}</span>
            </div>

            {lead.last_message_preview && (
              <div className="lead-preview">
                {lead.last_message_sender === "setter" ? "You: " : ""}
                {lead.last_message_preview}
              </div>
            )}

            <div className="lead-meta">
              {/* Which page is sending, shown whenever more than one is in view. */}
              {lead.outbound_account_handle && accountId === undefined && (
                <span className="badge" title={`Sending from @${lead.outbound_account_handle}`}>
                  @{lead.outbound_account_handle}
                </span>
              )}
              {lead.priority && lead.priority !== "medium" && lead.priority !== "low" && (
                <span className={`badge ${priorityTone(lead.priority)}`}>{lead.priority}</span>
              )}
              {lead.followup_status && lead.followup_status !== "none" && (
                <span className={`badge ${followupTone(lead.followup_status)}`}>
                  {FOLLOWUP_LABELS[lead.followup_status]}
                </span>
              )}
              {lead.conversation_stage && <span className="badge">{lead.conversation_stage}</span>}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
