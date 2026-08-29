"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppStatus, LeadDetail } from "@/lib/client";
import type {
  AgentResult,
  Lead,
  LeadListItem,
  NewLeadInput,
  OutboundAccount,
  Sender,
  SuggestionFeedback,
} from "@/lib/types";
import { FILTER_LABELS, LEAD_FILTERS, filterCounts, filterLeads, type LeadFilter } from "@/components/lead-filters";
import { clipboardReadSupported, copyText, readClipboard } from "@/components/clipboard";
import { InstallBanner } from "@/components/InstallPrompt";
import { MemoryPanel } from "@/components/MemoryPanel";
import { NewLeadDialog } from "@/components/NewLeadDialog";
import { relativeTime } from "@/components/format";

/**
 * The phone application.
 *
 * The operator works with Instagram open in another app: read the prospect's
 * reply, switch here, paste it, generate, copy the answer, switch back, send.
 * Every extra tap in that loop is paid many times a day, so the three desktop
 * columns become three screens and the reply that has to be copied is the
 * largest thing on the conversation screen.
 *
 * Everything the desktop shows is still reachable — qualification, memory,
 * retrieval, the audit — but under "Details", because none of it is what the
 * operator needs while actually replying.
 */

type Screen = "inbox" | "conversation" | "details";

export function MobileWorkspace(props: {
  status: AppStatus | null;
  leads: LeadListItem[];
  accounts: OutboundAccount[];
  accountId: string | undefined;
  onAccountChange: (id: string | undefined) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  detail: LeadDetail | null;
  result: AgentResult | null;
  generating: boolean;
  loadingLeads: boolean;
  genError: string | null;
  topError: string | null;
  onGenerate: (prospectMessage?: string) => void;
  onAddMessage: (sender: Sender, text: string) => Promise<void>;
  onFeedback: (feedback: SuggestionFeedback, finalMessage: string | null) => Promise<void>;
  onUpdateLead: (patch: Partial<Lead>) => Promise<void>;
  onCreateLead: (input: NewLeadInput & { acknowledge_duplicate?: boolean }) => Promise<void>;
  onCorrectMemory: (patch: Record<string, string[] | number>) => Promise<void>;
  onSignOut: () => void;
  accountFor: (lead: Lead | null | undefined) => OutboundAccount | null;
}) {
  const [screen, setScreen] = useState<Screen>("inbox");
  const [filter, setFilter] = useState<LeadFilter>("needs_reply");
  const [query, setQuery] = useState("");
  const [showAddReply, setShowAddReply] = useState(false);
  const [showNewLead, setShowNewLead] = useState(false);

  const { detail, result, accountFor } = props;
  const account = accountFor(detail?.lead);

  // Selecting a lead moves to its conversation; the inbox is a route, not a pane.
  const openLead = (id: string) => {
    props.onSelect(id);
    setScreen("conversation");
  };

  const counts = useMemo(() => filterCounts(props.leads, props.accountId), [props.leads, props.accountId]);
  const visible = useMemo(
    () => filterLeads(props.leads, { filter, query, accountId: props.accountId }),
    [props.leads, filter, query, props.accountId],
  );

  return (
    <div className="m-app">
      {screen === "inbox" && (
        <InboxScreen
          {...props}
          filter={filter}
          setFilter={setFilter}
          query={query}
          setQuery={setQuery}
          counts={counts}
          visible={visible}
          onOpenLead={openLead}
          onNewLead={() => setShowNewLead(true)}
        />
      )}

      {screen === "conversation" && detail && (
        <ConversationScreen
          {...props}
          detail={detail}
          account={account}
          onBack={() => setScreen("inbox")}
          onDetails={() => setScreen("details")}
          onAddReply={() => setShowAddReply(true)}
        />
      )}

      {screen === "details" && detail && (
        <DetailsScreen {...props} detail={detail} account={account} onBack={() => setScreen("conversation")} />
      )}

      {screen !== "inbox" && !detail && (
        <div className="m-empty">
          <p>That conversation is still loading.</p>
          <button className="btn" onClick={() => setScreen("inbox")}>
            Back to inbox
          </button>
        </div>
      )}

      {showAddReply && detail && (
        <AddReplySheet
          onClose={() => setShowAddReply(false)}
          onSave={async (text, generate) => {
            await props.onAddMessage("prospect", text);
            setShowAddReply(false);
            // Logging the reply and asking what to say next is one intention.
            if (generate) props.onGenerate("");
          }}
        />
      )}

      {showNewLead && (
        <NewLeadDialog
          onClose={() => setShowNewLead(false)}
          onCreate={async (input) => {
            await props.onCreateLead(input);
            setShowNewLead(false);
            setScreen("conversation");
          }}
          accounts={props.accounts}
          defaultAccountId={props.accountId ?? null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

function InboxScreen({
  leads,
  accounts,
  accountId,
  onAccountChange,
  loadingLeads,
  topError,
  filter,
  setFilter,
  query,
  setQuery,
  counts,
  visible,
  onOpenLead,
  onNewLead,
  onSignOut,
}: {
  leads: LeadListItem[];
  accounts: OutboundAccount[];
  accountId: string | undefined;
  onAccountChange: (id: string | undefined) => void;
  loadingLeads: boolean;
  topError: string | null;
  filter: LeadFilter;
  setFilter: (f: LeadFilter) => void;
  query: string;
  setQuery: (q: string) => void;
  counts: Record<LeadFilter, number>;
  visible: LeadListItem[];
  onOpenLead: (id: string) => void;
  onNewLead: () => void;
  onSignOut: () => void;
}) {
  return (
    <>
      <header className="m-header">
        <div className="m-header-row">
          <h1>Leads</h1>
          <span className="spacer" />
          <button className="m-link" onClick={onSignOut}>
            Sign out
          </button>
        </div>

        {/* Which page is sending is the first decision on this screen, not a
            setting buried elsewhere. */}
        <div className="m-tabs" role="group" aria-label="Outbound account">
          <button className="m-tab" aria-pressed={accountId === undefined} onClick={() => onAccountChange(undefined)}>
            All accounts
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              className="m-tab"
              aria-pressed={accountId === a.id}
              onClick={() => onAccountChange(a.id)}
            >
              @{a.handle}
            </button>
          ))}
        </div>

        <input
          className="m-search"
          type="search"
          inputMode="search"
          autoComplete="off"
          placeholder="Search @handle or name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search leads"
        />

        <div className="m-chips" role="group" aria-label="Filter leads">
          {LEAD_FILTERS.map((key) => (
            <button key={key} className="m-chip" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {FILTER_LABELS[key]}
              {counts[key] > 0 ? ` ${counts[key]}` : ""}
            </button>
          ))}
        </div>
      </header>

      <main className="m-list">
        <InstallBanner />
        {topError && <p className="error m-pad">{topError}</p>}
        {loadingLeads && leads.length === 0 && <p className="m-empty-line">Loading…</p>}
        {!loadingLeads && visible.length === 0 && (
          <p className="m-empty-line">
            {leads.length === 0 ? "No leads yet. Add your first prospect." : "Nothing matches this filter."}
          </p>
        )}

        {visible.map((lead) => (
          <button key={lead.id} className="m-lead" onClick={() => onOpenLead(lead.id)}>
            <div className="m-lead-top">
              {lead.awaiting_reply && <span className="dot" aria-label="Waiting on your reply" />}
              <span className="m-lead-name">{lead.name ?? `@${lead.instagram_handle}`}</span>
              <span className="spacer" />
              <span className="m-lead-time">{relativeTime(lead.last_message_at)}</span>
            </div>
            <div className="m-lead-sub">
              @{lead.instagram_handle}
              {lead.outbound_account_handle && accountId === undefined ? ` · via @${lead.outbound_account_handle}` : ""}
            </div>
            {lead.last_message_preview && (
              <div className="m-lead-preview">
                {lead.last_message_sender === "setter" ? "You: " : ""}
                {lead.last_message_preview}
              </div>
            )}
          </button>
        ))}
      </main>

      <button className="m-fab" onClick={onNewLead} aria-label="Add a prospect">
        +
      </button>
    </>
  );
}

// ---------------------------------------------------------------------------
// Conversation — the screen the operator actually lives on
// ---------------------------------------------------------------------------

function ConversationScreen({
  detail,
  account,
  result,
  generating,
  genError,
  onBack,
  onDetails,
  onAddReply,
  onGenerate,
  onFeedback,
}: {
  detail: LeadDetail;
  account: OutboundAccount | null;
  result: AgentResult | null;
  generating: boolean;
  genError: string | null;
  onBack: () => void;
  onDetails: () => void;
  onAddReply: () => void;
  onGenerate: (prospectMessage?: string) => void;
  onFeedback: (feedback: SuggestionFeedback, finalMessage: string | null) => Promise<void>;
}) {
  const { lead, messages } = detail;
  const suggestion = result?.reviewer.final_reply ?? "";
  const [edited, setEdited] = useState(suggestion);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // A new suggestion replaces whatever was in the box; the operator's own edits
  // survive until the next generation, which is what "Sent edited" records.
  useEffect(() => setEdited(suggestion), [suggestion]);
  useEffect(() => setCopied(false), [suggestion]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, lead.id]);

  // A suggestion the operator has to scroll to find is a suggestion that costs a
  // gesture every single time, so it comes to them.
  useEffect(() => {
    if (suggestion) replyRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [suggestion]);

  // The whole message has to be readable before it is sent, so the box grows to
  // fit rather than hiding the end of it behind a scrollbar.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [edited]);

  const lastProspect = [...messages].reverse().find((m) => m.sender === "prospect");
  const wasEdited = edited.trim() !== suggestion.trim();

  const copy = async () => {
    const ok = await copyText(edited.trim());
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1800);
  };

  const feedback = async (kind: SuggestionFeedback) => {
    if (busy) return;
    setBusy(true);
    try {
      // "Sent edited" keeps the operator's wording alongside the suggestion, so
      // the coaching layer can see exactly what was changed and why.
      await onFeedback(kind, kind === "rejected" ? null : edited.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="m-header">
        <div className="m-header-row">
          <button className="m-back" onClick={onBack} aria-label="Back to leads">
            ‹
          </button>
          <div className="m-title">
            <strong>{lead.name ?? `@${lead.instagram_handle}`}</strong>
            <span>@{lead.instagram_handle}</span>
          </div>
          <span className="spacer" />
          <button className="m-link" onClick={onDetails}>
            Details
          </button>
        </div>

        {/* Impossible to miss on purpose: sending from the wrong page cannot be
            undone. */}
        <div className={`m-account ${account?.active === false ? "warn" : ""}`}>
          Sending from <strong>{account ? `@${account.handle}` : "no account set"}</strong>
        </div>
      </header>

      <main className="m-thread">
        {messages.length === 0 && <p className="m-empty-line">No messages logged yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`m-msg ${m.sender}`}>
            <div className="m-msg-text">{m.message_text}</div>
            <div className="m-msg-meta">{relativeTime(m.sent_at)}</div>
          </div>
        ))}
        <div ref={endRef} />

        {genError && <p className="error m-pad">{genError}</p>}

        {result && (
          <section className="m-reply" aria-label="Suggested reply" ref={replyRef}>
            <div className="m-reply-head">
              <span>Send this</span>
              <span className="spacer" />
              {result.gate.passed && <span className="badge good">call ready</span>}
              {result.understanding.confusion_reason && <span className="badge bad">confusion</span>}
            </div>

            <textarea
              ref={textRef}
              className="m-reply-text"
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              rows={3}
              aria-label="The DM to send"
            />

            <button className="m-copy" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy reply"}
            </button>

            <div className="m-feedback">
              <button className="m-fb good" disabled={busy} onClick={() => void feedback("used")}>
                Sent as-is
              </button>
              <button className="m-fb" disabled={busy} onClick={() => void feedback("edited")}>
                Sent edited{wasEdited ? " •" : ""}
              </button>
              <button className="m-fb bad" disabled={busy} onClick={() => void feedback("rejected")}>
                Reject
              </button>
            </div>

            <Collapsible title="Why this move">
              <p className="m-note">{result.plan.purpose}</p>
              <p className="m-note muted">Looking for: {result.plan.desired_response}</p>
              {result.booking.slots.length > 0 && (
                <p className="m-note muted">Times to offer: {result.booking.slots.join(" or ")}</p>
              )}
            </Collapsible>
          </section>
        )}
      </main>

      <nav className="m-actions" aria-label="Actions">
        <button className="m-action" onClick={onAddReply}>
          Add reply
        </button>
        <button className="m-action primary" disabled={generating} onClick={() => onGenerate("")}>
          {generating ? "Thinking…" : result ? "Regenerate" : "Generate"}
        </button>
      </nav>

      {lastProspect && !result && (
        <div className="m-latest" aria-live="polite">
          Latest: {lastProspect.message_text.slice(0, 90)}
          {lastProspect.message_text.length > 90 ? "…" : ""}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Add reply — the fastest path from Instagram to a suggestion
// ---------------------------------------------------------------------------

function AddReplySheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (text: string, generate: boolean) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const save = async (generate: boolean) => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onSave(value, generate);
    } finally {
      setBusy(false);
    }
  };

  // Only ever from this button: the clipboard is never read on its own.
  const paste = async () => {
    const clip = await readClipboard();
    if (clip) setText((current) => (current ? `${current}\n${clip}` : clip));
    ref.current?.focus();
  };

  return (
    <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Add the prospect's reply">
      <div className="m-sheet-body">
        <div className="m-sheet-head">
          <strong>Their reply</strong>
          <span className="spacer" />
          {clipboardReadSupported() && (
            <button className="m-link" onClick={() => void paste()}>
              Paste
            </button>
          )}
          <button className="m-link" onClick={onClose}>
            Cancel
          </button>
        </div>

        <textarea
          ref={ref}
          className="m-sheet-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste what they just sent"
          rows={4}
          aria-label="The prospect's message"
        />

        <div className="m-sheet-actions">
          <button className="m-action" disabled={busy || !text.trim()} onClick={() => void save(false)}>
            Save only
          </button>
          <button className="m-action primary" disabled={busy || !text.trim()} onClick={() => void save(true)}>
            {busy ? "Saving…" : "Save & generate"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Details — everything that must not be in the way while replying
// ---------------------------------------------------------------------------

function DetailsScreen({
  detail,
  account,
  result,
  status,
  onBack,
  onCorrectMemory,
}: {
  detail: LeadDetail;
  account: OutboundAccount | null;
  result: AgentResult | null;
  status: AppStatus | null;
  onBack: () => void;
  onCorrectMemory: (patch: Record<string, string[] | number>) => Promise<void>;
}) {
  const { lead } = detail;

  return (
    <>
      <header className="m-header">
        <div className="m-header-row">
          <button className="m-back" onClick={onBack} aria-label="Back to the conversation">
            ‹
          </button>
          <div className="m-title">
            <strong>Details</strong>
            <span>@{lead.instagram_handle}</span>
          </div>
        </div>
        <div className="m-account">
          Sending from <strong>{account ? `@${account.handle}` : "no account set"}</strong>
        </div>
      </header>

      <main className="m-details">
        {!result && <p className="m-empty-line">Generate a reply to see the reasoning behind it.</p>}

        {result && (
          <>
            <Collapsible title="Why this move" defaultOpen>
              <p className="m-note">{result.plan.purpose}</p>
              <p className="m-note muted">Move: {result.plan.move.replace(/_/g, " ")}</p>
              <p className="m-note muted">If they say yes: {result.plan.next_if_positive}</p>
              <p className="m-note muted">If they say no: {result.plan.next_if_negative}</p>
              <p className="m-note muted">If they go quiet: {result.plan.next_if_no_reply}</p>
            </Collapsible>

            <Collapsible title="Qualification">
              <p className="m-note">
                {result.gate.passed ? "Call ready." : `Blocked: ${result.gate.blockers.join("; ") || "not yet"}`}
              </p>
              <ul className="list">
                {Object.entries(result.strategy.qualification).map(([key, value]) => (
                  <li key={key}>
                    {key.replace(/_/g, " ")}: {value}/2
                  </li>
                ))}
              </ul>
              <p className="m-note muted">
                Booking: {result.booking.state.replace(/_/g, " ")} · no-show risk {result.booking.no_show_risk}{" "}
                (advisory)
              </p>
            </Collapsible>

            <Collapsible title="Agent checks">
              <p className="m-note">{result.audit.ok ? "No violations." : "Issues found:"}</p>
              <ul className="list">
                {result.audit.violations.map((v) => (
                  <li key={`${v.rule}-${v.detail}`}>
                    [{v.severity}] {v.detail}
                  </li>
                ))}
              </ul>
              <p className="m-note muted">
                {result.audit.words} words · engine {result.engine}
                {status?.setter_model ? ` · ${status.setter_model}` : ""}
              </p>
            </Collapsible>

            <Collapsible title="Similar conversations">
              <ul className="list">
                {result.examples.strong_winners.map((c) => (
                  <li key={c.id}>Winner ({c.outcome_tier}): {c.content.slice(0, 160)}</li>
                ))}
                {result.examples.failures.map((c) => (
                  <li key={c.id}>Do not repeat ({c.outcome_tier}): {c.content.slice(0, 160)}</li>
                ))}
                {result.examples.strong_winners.length + result.examples.failures.length === 0 && (
                  <li className="muted">Nothing retrieved yet.</li>
                )}
              </ul>
            </Collapsible>
          </>
        )}

        <Collapsible title="What we know">
          <MemoryPanel
            memory={detail.memory}
            understanding={
              result
                ? {
                    level: result.understanding.level,
                    service_explained: result.understanding.service_explained,
                    confusion_reason: result.understanding.confusion_reason,
                  }
                : null
            }
            onCorrect={onCorrectMemory}
          />
        </Collapsible>
      </main>
    </>
  );
}

function Collapsible({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="m-collapse" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="m-collapse-body">{children}</div>
    </details>
  );
}
