"use client";

import { useCallback, useEffect, useState } from "react";
import type { OutcomeTier, TranscriptStatus } from "@/lib/types";
import { TIER_DESCRIPTIONS } from "@/lib/types";

/**
 * Transcript verification workflow.
 *
 * Machine transcription is never ground truth: a conversation stays out of
 * retrieval until a person has read it here and approved it. The reviewer can
 * fix the text before approving, which is the only way corrections enter the
 * corpus.
 */

type CorpusRow = {
  id: string;
  instagram_handle: string | null;
  setter_name: string | null;
  outcome: string | null;
  outcome_tier: OutcomeTier | null;
  status: TranscriptStatus;
  screenshot_count: number;
  transcript: string | null;
  labels: Record<string, unknown> | null;
  verified_by: string | null;
};

const STATUS_TONE: Record<TranscriptStatus, string> = {
  pending_ocr: "",
  needs_review: "warn",
  verified: "good",
  rejected: "bad",
};

export function CorpusPanel({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<CorpusRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<TranscriptStatus | "all">("needs_review");
  const [selected, setSelected] = useState<CorpusRow | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/corpus");
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Could not load the corpus");
      setRows(payload.conversations);
      setCounts(payload.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the corpus");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = filter === "all" ? rows : rows.filter((r) => r.status === filter);

  const act = async (status: TranscriptStatus) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/corpus/${selected.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status, transcript: draft }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Update failed");
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const confidence = (row: CorpusRow) => {
    const labels = row.labels as { transcript_confidence?: number; ordering_confidence?: number; uncertain_message_count?: number } | null;
    if (!labels?.transcript_confidence) return null;
    return labels;
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Historical corpus" onClick={onClose}>
      <div className="dialog" style={{ width: "min(1000px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <h2>Historical corpus</h2>
        <p className="muted">
          Only verified transcripts can influence live suggestions. Machine transcription is a draft, never ground truth.
        </p>

        <div className="lead-filters" style={{ padding: "0 0 12px" }}>
          {(["needs_review", "verified", "pending_ocr", "rejected", "all"] as const).map((s) => (
            <button key={s} className="chip" aria-pressed={filter === s} onClick={() => setFilter(s)}>
              {s.replace("_", " ")} {s !== "all" ? `(${counts[s] ?? 0})` : `(${rows.length})`}
            </button>
          ))}
        </div>

        {error && <p className="error">{error}</p>}

        {selected ? (
          <>
            <h3 style={{ fontSize: 13 }}>
              @{selected.instagram_handle ?? "unknown"} · {selected.outcome} · tier {selected.outcome_tier}
              {selected.outcome_tier && ` (${TIER_DESCRIPTIONS[selected.outcome_tier]})`}
            </h3>
            {(() => {
              const c = confidence(selected);
              return c ? (
                <p className="muted">
                  transcription confidence {c.transcript_confidence} · ordering {c.ordering_confidence} ·{" "}
                  {c.uncertain_message_count ?? 0} uncertain passages
                </p>
              ) : (
                <p className="muted">No transcript yet — run `npm run ingest:transcribe`.</p>
              );
            })()}
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              style={{ width: "100%", minHeight: 320, fontFamily: "var(--mono)", fontSize: 12 }}
              aria-label="Transcript"
            />
            <p className="muted" style={{ marginTop: 6 }}>
              Fix anything misread before approving. ⚠️ marks a passage the model could not read confidently.
            </p>
            <div className="dialog-actions">
              <button className="btn ghost" onClick={() => setSelected(null)}>Back</button>
              <button className="btn bad" onClick={() => act("rejected")} disabled={busy}>Reject</button>
              <button className="btn good" onClick={() => act("verified")} disabled={busy || !draft.trim()}>
                {busy ? <span className="spin" /> : "Approve for retrieval"}
              </button>
            </div>
          </>
        ) : (
          <div className="preview-list" style={{ maxHeight: 420 }}>
            {visible.length === 0 && <p className="muted">Nothing in this state.</p>}
            {visible.map((row) => (
              <button
                key={row.id}
                className="preview-item"
                style={{ width: "100%", textAlign: "left", background: "none", border: "none", borderBottom: "1px solid var(--border-soft)", color: "inherit" }}
                onClick={() => {
                  setSelected(row);
                  setDraft(row.transcript ?? "");
                }}
              >
                <span className={`badge ${STATUS_TONE[row.status]}`} style={{ flex: "none" }}>{row.status.replace("_", " ")}</span>
                <span style={{ flex: 1 }}>
                  @{row.instagram_handle ?? "unknown"}
                  <span className="muted"> · {row.outcome} · {row.screenshot_count} shots · {row.setter_name ?? "unattributed"}</span>
                </span>
                {row.outcome_tier && <span className="badge">{row.outcome_tier}</span>}
              </button>
            ))}
          </div>
        )}

        {!selected && (
          <div className="dialog-actions">
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
