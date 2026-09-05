"use client";

import { useEffect, useRef, useState } from "react";
import type { Lead, Message, OutboundAccount, Sender } from "@/lib/types";
import { FOLLOWUP_STATUSES, PRIORITIES } from "@/lib/types";
import { FOLLOWUP_LABELS, PRIORITY_LABELS, absoluteTime, toDateInput } from "@/components/format";

export function ConversationView({
  lead,
  messages,
  onUpdateLead,
  onAddMessage,
  onImport,
  onGenerate,
  generating,
  account,
}: {
  lead: Lead;
  messages: Message[];
  /** The page this conversation is being sent from. */
  account?: OutboundAccount | null;
  onUpdateLead: (patch: Partial<Lead>) => Promise<void>;
  onAddMessage: (sender: Sender, text: string) => Promise<void>;
  onImport: () => void;
  onGenerate: (prospectMessage: string) => void;
  generating: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [sender, setSender] = useState<Sender>("prospect");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lead.id]);

  const add = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onAddMessage(sender, text);
      setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const lastProspect = [...messages].reverse().find((m) => m.sender === "prospect");

  return (
    <section className="column" aria-label="Conversation">
      <div className="lead-header">
        <h2>
          {lead.name ?? `@${lead.instagram_handle}`}{" "}
          <span className="lead-handle" style={{ fontWeight: 400 }}>
            @{lead.instagram_handle}
          </span>
        </h2>
        {/* Which page is talking to this person is never a detail: sending from
            the wrong account is not recoverable. */}
        <div className="account-line">
          Sending from{" "}
          <strong>{account ? `@${account.handle}` : "an unassigned account"}</strong>
          {account?.display_name ? ` · ${account.display_name}` : ""}
          {account && !account.active ? " · retired" : ""}
        </div>
        <div className="sub">
          {[lead.job_title, lead.company, lead.niche, lead.location].filter(Boolean).join(" · ") ||
            "No profile details yet"}
        </div>
        {lead.commercial_goal && (
          <div className="sub">
            <strong style={{ color: "var(--text)" }}>Goal:</strong> {lead.commercial_goal}
          </div>
        )}
        {lead.media_gap && (
          <div className="sub">
            <strong style={{ color: "var(--text)" }}>Gap:</strong> {lead.media_gap}
          </div>
        )}

        <div className="lead-controls">
          <label className="field">
            Priority
            <select
              value={lead.priority ?? "medium"}
              onChange={(e) => onUpdateLead({ priority: e.target.value as Lead["priority"] })}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Follow-up
            <select
              value={lead.followup_status ?? "none"}
              onChange={(e) => onUpdateLead({ followup_status: e.target.value as Lead["followup_status"] })}
            >
              {FOLLOWUP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {FOLLOWUP_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            Due
            <input
              type="date"
              value={toDateInput(lead.next_followup_at)}
              onChange={(e) =>
                onUpdateLead({
                  next_followup_at: e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null,
                })
              }
            />
          </label>

          <span style={{ flex: 1 }} />
          <button className="btn small ghost" onClick={onImport}>
            Import DMs
          </button>
        </div>

        {lead.followup_note && <div className="sub" style={{ marginTop: 8 }}>{lead.followup_note}</div>}
      </div>

      <div className="column-body">
        {messages.length === 0 ? (
          <p className="empty">
            No messages yet. Paste an existing thread with <strong>Import DMs</strong>, or add the first message below.
          </p>
        ) : (
          <div className="thread">
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.sender}`}>
                {m.message_text}
                <span className="when">
                  {absoluteTime(m.sent_at)}
                  {m.sent_by_ai ? " · AI" : ""}
                </span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <div className="composer">
        <textarea
          value={draft}
          placeholder={
            sender === "prospect" ? "Paste what they just said…" : "Log a message you sent…"
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void add();
            }
          }}
          aria-label="New message"
        />
        <div className="composer-row">
          <select value={sender} onChange={(e) => setSender(e.target.value as Sender)} aria-label="Message sender">
            <option value="prospect">From prospect</option>
            <option value="setter">From you</option>
            <option value="system">Internal note</option>
          </select>
          <button className="btn" onClick={add} disabled={busy || !draft.trim()}>
            Add to thread
          </button>
          <span style={{ flex: 1 }} />
          <button
            className="btn primary"
            onClick={() => onGenerate(sender === "prospect" ? draft.trim() : "")}
            disabled={generating}
            title={
              lastProspect
                ? "Run the setter pipeline over this conversation"
                : "Add what they said first, or generate an opener"
            }
          >
            {generating ? (
              <>
                <span className="spin" /> Thinking…
              </>
            ) : (
              "Ask the copilot"
            )}
          </button>
        </div>
        <span className="muted">
          ⌘/Ctrl + Enter adds to the thread. &quot;Ask the copilot&quot; uses the whole conversation, plus anything typed above.
        </span>
      </div>
    </section>
  );
}
