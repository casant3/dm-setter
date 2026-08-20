"use client";

import { useMemo, useState } from "react";
import type { LeadListItem } from "@/lib/types";
import { FOLLOWUP_LABELS, followupTone, priorityTone, relativeTime } from "@/components/format";

type Filter = "all" | "needs_reply" | "followup_due" | "high_priority";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "needs_reply", label: "Needs reply" },
  { key: "followup_due", label: "Follow-up due" },
  { key: "high_priority", label: "High priority" },
];

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

function isDue(lead: LeadListItem): boolean {
  if (lead.followup_status === "overdue" || lead.followup_status === "owed_reply") return true;
  if (!lead.next_followup_at) return false;
  return new Date(lead.next_followup_at).getTime() <= Date.now();
}

export function LeadsSidebar({
  leads,
  selectedId,
  onSelect,
  onNewLead,
  loading,
}: {
  leads: LeadListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewLead: () => void;
  loading: boolean;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads
      .filter((lead) => {
        if (filter === "needs_reply" && !lead.awaiting_reply) return false;
        if (filter === "followup_due" && !isDue(lead)) return false;
        if (filter === "high_priority" && lead.priority !== "high" && lead.priority !== "urgent") return false;
        if (!q) return true;
        return [lead.name, lead.instagram_handle, lead.company, lead.niche]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => {
        // Threads waiting on us come first, then priority, then recency.
        if (a.awaiting_reply !== b.awaiting_reply) return a.awaiting_reply ? -1 : 1;
        const pa = PRIORITY_RANK[a.priority ?? "medium"];
        const pb = PRIORITY_RANK[b.priority ?? "medium"];
        if (pa !== pb) return pa - pb;
        return (b.last_message_at ?? "").localeCompare(a.last_message_at ?? "");
      });
  }, [leads, filter, query]);

  const counts = useMemo(
    () => ({
      needsReply: leads.filter((l) => l.awaiting_reply).length,
      due: leads.filter(isDue).length,
    }),
    [leads],
  );

  return (
    <section className="column" aria-label="Leads">
      <div className="column-header">
        <span className="column-title">Leads</span>
        <span className="badge">{leads.length}</span>
        {counts.needsReply > 0 && <span className="badge bad">{counts.needsReply} awaiting</span>}
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

      <div className="lead-filters" role="group" aria-label="Filter leads">
        {FILTERS.map((f) => (
          <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
            {f.key === "followup_due" && counts.due > 0 ? ` (${counts.due})` : ""}
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
