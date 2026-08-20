"use client";

import { useState } from "react";
import { api, type ImportPreview } from "@/lib/client";
import type { Lead, Sender } from "@/lib/types";

const PLACEHOLDER = `Me: saw your post about the raise — how far along are you?
Them: prepping a seed round for Q3
Me: what comes up when investors look you up right now?
Them: honestly not much`;

/** Paste a thread, check how each line was attributed, then import. */
export function ImportDialog({
  lead,
  onClose,
  onImported,
}: {
  lead: Lead;
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const [transcript, setTranscript] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Sender>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runPreview = async (nextOverrides = overrides) => {
    setError(null);
    setBusy(true);
    try {
      setPreview(await api.previewImport(lead.id, transcript, nextOverrides));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not parse that");
    } finally {
      setBusy(false);
    }
  };

  const setOverride = async (label: string, sender: Sender) => {
    const next = { ...overrides, [label]: sender };
    setOverrides(next);
    await runPreview(next);
  };

  const commit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.commitImport(lead.id, transcript, overrides);
      await onImported();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Import DMs" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Import DMs for @{lead.instagram_handle}</h2>
        <p className="muted">
          Paste the thread. &quot;Me:&quot; and &quot;Them:&quot; both work, as does an Instagram export where the
          sender is on its own line. Imported messages are appended to this lead&apos;s permanent memory.
        </p>

        <textarea
          value={transcript}
          onChange={(e) => {
            setTranscript(e.target.value);
            setPreview(null);
          }}
          placeholder={PLACEHOLDER}
          style={{ width: "100%", minHeight: 170, resize: "vertical" }}
          aria-label="Pasted conversation"
        />

        {preview && (
          <>
            <p className="muted" style={{ marginTop: 10 }}>
              {preview.counts.total} messages · {preview.counts.setter} from you · {preview.counts.prospect} from them
            </p>

            {preview.warnings.map((w) => (
              <p key={w} className="error">
                {w}
              </p>
            ))}

            {preview.unknown_labels.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {preview.unknown_labels.map((label) => (
                  <div key={label} className="field" style={{ marginBottom: 6 }}>
                    <span>
                      &quot;{label}&quot; is
                    </span>
                    <select
                      value={overrides[label] ?? "prospect"}
                      onChange={(e) => void setOverride(label, e.target.value as Sender)}
                    >
                      <option value="prospect">the prospect</option>
                      <option value="setter">you</option>
                      <option value="system">an internal note</option>
                    </select>
                  </div>
                ))}
              </div>
            )}

            <div className="preview-list">
              {preview.preview.map((m, i) => (
                <div key={i} className="preview-item">
                  <span className="preview-tag">{m.sender === "setter" ? "you" : m.sender}</span>
                  <span>{m.message_text}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}

        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" onClick={() => void runPreview()} disabled={busy || !transcript.trim()}>
            {busy && !preview ? <span className="spin" /> : "Preview"}
          </button>
          <button
            className="btn primary"
            onClick={commit}
            disabled={busy || !preview || preview.counts.total === 0}
            title={preview ? "" : "Preview the parse first"}
          >
            {busy && preview ? <span className="spin" /> : `Import${preview ? ` ${preview.counts.total}` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}
