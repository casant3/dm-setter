"use client";

import { useState } from "react";
import { PRIORITIES, type NewLeadInput, type OutboundAccount, type Priority } from "@/lib/types";
import { PRIORITY_LABELS } from "@/components/format";
import { DuplicateProspectError, type DuplicateWarning } from "@/lib/client";

export function NewLeadDialog({
  onClose,
  onCreate,
  accounts,
  defaultAccountId,
}: {
  onClose: () => void;
  onCreate: (input: NewLeadInput & { acknowledge_duplicate?: boolean }) => Promise<void>;
  accounts: OutboundAccount[];
  defaultAccountId?: string | null;
}) {
  // With one page there is nothing to choose. With several, the page is chosen
  // deliberately or not at all: defaulting to whichever happens to sort first is
  // how a prospect gets messaged from the wrong account, which cannot be undone.
  const [form, setForm] = useState<NewLeadInput>({
    instagram_handle: "",
    priority: "medium",
    outbound_account_id: defaultAccountId ?? (accounts.length === 1 ? accounts[0].id : null),
  });
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<DuplicateWarning | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof NewLeadInput) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent, acknowledge = false) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onCreate({
        ...form,
        instagram_handle: form.instagram_handle.trim().replace(/^@/, ""),
        acknowledge_duplicate: acknowledge,
      });
    } catch (err) {
      // Already being contacted from another page: show it, then let the
      // operator decide. Duplicates are sometimes deliberate, never accidental.
      if (err instanceof DuplicateProspectError) setDuplicate(err.duplicate);
      else setError(err instanceof Error ? err.message : "Could not create the lead");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Add a lead" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h2>Add a lead</h2>
        <p className="muted">
          Only the handle is required. Everything else feeds qualification, so fill in what you already know.
        </p>

        <div className="form-grid">
          <label className="form-full">
            Sending from *
            <select
              value={form.outbound_account_id ?? ""}
              onChange={(e) => setForm((f) => ({ ...f, outbound_account_id: e.target.value || null }))}
            >
              {accounts.length === 0 && <option value="">No outbound account yet</option>}
              {accounts.length > 1 && !form.outbound_account_id && <option value="">Choose the page…</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.handle}
                  {a.display_name ? ` — ${a.display_name}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="form-full">
            Instagram handle *
            <input
              type="text"
              required
              autoFocus
              placeholder="codyalt"
              value={form.instagram_handle}
              onChange={set("instagram_handle")}
            />
          </label>
          <label>
            Name
            <input type="text" value={form.name ?? ""} onChange={set("name")} />
          </label>
          <label>
            Company
            <input type="text" value={form.company ?? ""} onChange={set("company")} />
          </label>
          <label>
            Job title
            <input type="text" value={form.job_title ?? ""} onChange={set("job_title")} />
          </label>
          <label>
            Location
            <input type="text" value={form.location ?? ""} onChange={set("location")} />
          </label>
          <label>
            Industry
            <input type="text" placeholder="Fintech" value={form.industry ?? ""} onChange={set("industry")} />
          </label>
          <label>
            Niche
            <input type="text" placeholder="SMB accounting" value={form.niche ?? ""} onChange={set("niche")} />
          </label>
          <label className="form-full">
            Commercial or authority goal
            <input
              type="text"
              placeholder="Raising a seed round and wants credibility first"
              value={form.commercial_goal ?? ""}
              onChange={set("commercial_goal")}
            />
          </label>
          <label className="form-full">
            Media gap
            <input
              type="text"
              placeholder="No written press, nothing ranks in search"
              value={form.media_gap ?? ""}
              onChange={set("media_gap")}
            />
          </label>
          <label>
            Priority
            <select
              value={form.priority ?? "medium"}
              onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as Priority }))}
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <p className="error" style={{ marginTop: 12 }}>{error}</p>}

        {duplicate && (
          <div className="warn-box" role="alert">
            <strong>Already being contacted</strong>
            <p style={{ margin: "6px 0" }}>{duplicate.message}</p>
            <ul className="list">
              {duplicate.matches.map((m) => (
                <li key={m.lead_id}>
                  {m.account_handle ? `@${m.account_handle}` : "no account"} · {m.conversation_stage ?? "no stage"}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {duplicate ? (
            <button
              type="button"
              className="btn bad"
              disabled={busy}
              onClick={(e) => void submit(e as unknown as React.FormEvent, true)}
            >
              Add anyway
            </button>
          ) : (
            <button
              type="submit"
              className="btn primary"
              disabled={busy || !form.instagram_handle.trim() || (accounts.length > 0 && !form.outbound_account_id)}
            >
              {busy ? <span className="spin" /> : "Add lead"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
