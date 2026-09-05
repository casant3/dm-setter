"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { OutboundAccount } from "@/lib/types";

type Preview = Awaited<ReturnType<typeof api.previewSheet>>;

/**
 * Importing the daily lead list.
 *
 * The sheet is edited by hand throughout the day, so this never writes straight
 * from it: the first step shows what was found — how many days, how many
 * handles, which are new, which are already in the pipeline, which cells could
 * not be read — and only then does the operator choose a page and commit.
 */
export function SheetImportPanel({
  accounts,
  onClose,
  onImported,
}: {
  accounts: OutboundAccount[];
  onClose: () => void;
  onImported: (count: number) => void;
}) {
  const [sheetUrl, setSheetUrl] = useState("");
  const [csv, setCsv] = useState("");
  const [accountId, setAccountId] = useState<string>(accounts.length === 1 ? accounts[0].id : "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [status, setStatus] = useState<{ service_account: boolean; service_account_email: string | null; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.sheetImportStatus());
    } catch {
      // The hint is optional; the panel works without it.
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const look = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setPreview(await api.previewSheet({ sheet_url: sheetUrl || undefined, csv: csv || undefined, outbound_account_id: accountId || null }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that sheet");
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!accountId) {
      setError("Choose which page these leads were sent from");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.commitSheet({
        sheet_url: sheetUrl || undefined,
        csv: csv || undefined,
        outbound_account_id: accountId,
      });
      setDone(`Imported ${result.imported} lead${result.imported === 1 ? "" : "s"} to @${result.account}.`);
      setPreview(null);
      onImported(result.imported);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not import those leads");
    } finally {
      setBusy(false);
    }
  };

  const s = preview?.summary;

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Import leads" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Import leads</h2>
        <p className="muted">
          From the lead vault sheet. Nothing is created until you have seen what was found and chosen the page it was
          sent from.
        </p>

        {error && <p className="error">{error}</p>}
        {done && <p className="badge good" style={{ display: "inline-block" }}>{done}</p>}

        <label className="form-full">
          Google Sheets link
          <input
            type="url"
            inputMode="url"
            placeholder="https://docs.google.com/spreadsheets/d/…"
            value={sheetUrl}
            onChange={(e) => setSheetUrl(e.target.value)}
          />
        </label>
        {status && <p className="muted" style={{ marginTop: 4 }}>{status.note}</p>}

        <p className="muted" style={{ margin: "10px 0 4px" }}>Or paste the tab (select the cells in Sheets and copy):</p>
        <textarea
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          rows={4}
          placeholder="03/09/2026	firstlead	secondlead - investor	…"
          style={{ width: "100%" }}
          aria-label="Paste the tab's contents"
        />
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) setCsv(await file.text());
          }}
        />
        <button className="btn small ghost" style={{ marginTop: 6 }} onClick={() => fileRef.current?.click()}>
          Or choose a CSV file
        </button>

        <label className="form-full" style={{ marginTop: 12 }}>
          Sent from *
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.length !== 1 && <option value="">Choose the page…</option>}
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.handle}
                {a.display_name ? ` — ${a.display_name}` : ""}
              </option>
            ))}
          </select>
        </label>

        {s && (
          <div className="warn-box" style={{ marginTop: 12 }}>
            <strong>What was found</strong>
            <ul className="list">
              <li>
                {s.found} handle{s.found === 1 ? "" : "s"} across {s.days_with_leads} day
                {s.days_with_leads === 1 ? "" : "s"}
                {s.empty_days > 0
                  ? ` (${s.empty_days} more ${s.empty_days === 1 ? "day is" : "days are"} still empty)`
                  : ""}
              </li>
              <li>
                <strong>{s.new} new</strong>
                {s.already_in_pipeline > 0 ? `, ${s.already_in_pipeline} already in the pipeline` : ""}
                {s.repeated_in_sheet > 0 ? `, ${s.repeated_in_sheet} repeated in the sheet` : ""}
              </li>
              {s.also_on_another_account > 0 && (
                <li>{s.also_on_another_account} are also being contacted from another page</li>
              )}
              {s.blocks.length > 0 && <li>The sheet labels these rows: {s.blocks.join(", ")}</li>}
              {s.unreadable_cells > 0 && <li>{s.unreadable_cells} cells were not handles and were skipped</li>}
            </ul>
            {preview.sample.length > 0 && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                First few: {preview.sample.slice(0, 6).map((c) => `@${c.instagram_handle}`).join(", ")}
              </p>
            )}
            {preview.skipped.length > 0 && (
              <p className="muted" style={{ margin: "6px 0 0" }}>
                Skipped: {preview.skipped.slice(0, 3).map((x) => `"${x.raw.slice(0, 30)}"`).join(", ")}
              </p>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Close
          </button>
          <button className="btn" disabled={busy || (!sheetUrl && !csv)} onClick={() => void look()}>
            {busy && !preview ? <span className="spin" /> : "Look at the sheet"}
          </button>
          {s && s.new > 0 && (
            <button className="btn primary" disabled={busy || !accountId} onClick={() => void commit()}>
              {busy ? <span className="spin" /> : `Import ${s.new}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
