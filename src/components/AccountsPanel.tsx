"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { isLegacyAccount, normaliseHandle } from "@/core/accounts";
import type { OutboundAccount } from "@/lib/types";

/**
 * The Instagram pages outreach runs from.
 *
 * Attribution only: nothing here stores a credential, logs in, or sends
 * anything. Adding a page here is what makes it selectable when a lead is
 * created and what gives the inbox its account tabs.
 *
 * Retiring a page is deliberately not deleting it. The conversations it sent
 * are still attributed to it and still count in its analytics; retiring only
 * takes it out of the list offered for new outreach.
 */
export function AccountsPanel({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [accounts, setAccounts] = useState<OutboundAccount[]>([]);
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { accounts: rows } = await api.listAccounts(true);
      setAccounts(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = normaliseHandle(handle);
    if (!cleaned || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createAccount({
        handle: cleaned,
        display_name: displayName.trim() || null,
        notes: notes.trim() || null,
      });
      setHandle("");
      setDisplayName("");
      setNotes("");
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that account");
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (account: OutboundAccount, active: boolean) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAccount(account.id, { active });
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that account");
    } finally {
      setBusy(false);
    }
  };

  const live = accounts.filter((a) => a.active);
  const retired = accounts.filter((a) => !a.active);

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Outbound accounts" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Outbound accounts</h2>
        <p className="muted">
          The Instagram pages you send from. This never logs in or sends anything — it records which page a
          conversation belongs to, so two pages can never be mistaken for one.
        </p>

        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading…</p>}

        {live.length > 0 && (
          <>
            <h3 style={{ fontSize: 13 }}>Sending</h3>
            <ul className="list">
              {live.map((account) => (
                <li key={account.id} className="account-row">
                  <div>
                    <strong>@{account.handle}</strong>
                    {account.display_name ? <span className="muted"> · {account.display_name}</span> : null}
                    {account.notes ? <div className="muted">{account.notes}</div> : null}
                  </div>
                  <span className="spacer" style={{ flex: 1 }} />
                  <button className="btn small ghost" disabled={busy} onClick={() => void setActive(account, false)}>
                    Retire
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {retired.length > 0 && (
          <>
            <h3 style={{ fontSize: 13 }}>Not in use</h3>
            <ul className="list">
              {retired.map((account) => (
                <li key={account.id} className="account-row">
                  <div>
                    <strong>@{account.handle}</strong>
                    {account.display_name ? <span className="muted"> · {account.display_name}</span> : null}
                    {isLegacyAccount(account) && (
                      <div className="muted">
                        Conversations from before account tracking. Kept unassignable on purpose — never guess which
                        page sent them.
                      </div>
                    )}
                  </div>
                  <span className="spacer" style={{ flex: 1 }} />
                  {!isLegacyAccount(account) && (
                    <button className="btn small ghost" disabled={busy} onClick={() => void setActive(account, true)}>
                      Use again
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {!loading && live.length === 0 && (
          <p className="muted">
            No pages yet. Add the account you send from and it becomes selectable when you add a prospect.
          </p>
        )}

        <form onSubmit={(e) => void add(e)}>
          <h3 style={{ fontSize: 13 }}>Add a page</h3>
          <div className="form-grid">
            <label>
              Instagram handle *
              <input
                type="text"
                required
                placeholder="cassey.media"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </label>
            <label>
              Label
              <input
                type="text"
                placeholder="Main page"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label className="form-full">
              Note
              <input
                type="text"
                placeholder="What this page is for"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
          </div>

          <div className="dialog-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="btn primary" disabled={busy || !handle.trim()}>
              {busy ? <span className="spin" /> : "Add page"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
