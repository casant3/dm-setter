"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/client";
import type { Sender } from "@/lib/types";

type Line = { sender: Sender; text: string; confidence: "high" | "low"; partial: boolean };

/**
 * Adding a conversation from a screenshot.
 *
 * Screenshot the Instagram thread, send it here, check what was read, add it.
 * The read is a proposal: every line can be corrected and the sender flipped
 * before anything touches the thread, because a transcript that invents a line
 * the prospect never wrote would corrupt the qualification evidence and the
 * memory built on top of it.
 *
 * The image is never stored. It is read and dropped.
 */
export function ScreenshotSheet({
  leadId,
  onClose,
  onAdded,
}: {
  leadId: string;
  onClose: () => void;
  onAdded: (added: number) => void;
}) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [unreadable, setUnreadable] = useState<string[]>([]);
  const [alreadyInThread, setAlreadyInThread] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const read = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read that image"));
        reader.readAsDataURL(file);
      });
      const result = await api.readScreenshot(leadId, dataUrl);
      setLines(result.lines);
      setUnreadable(result.unreadable);
      setAlreadyInThread(result.already_in_thread);
      if (result.lines.length === 0) {
        setError(
          result.already_in_thread > 0
            ? "Everything in that screenshot is already in the thread."
            : "Nothing readable was found in that screenshot.",
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that screenshot");
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!lines?.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.addScreenshotLines(
        leadId,
        lines.map((l) => ({ sender: l.sender, text: l.text })),
      );
      onAdded(result.added);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add those messages");
      setBusy(false);
    }
  };

  const update = (index: number, patch: Partial<Line>) =>
    setLines((current) => current?.map((l, i) => (i === index ? { ...l, ...patch } : l)) ?? null);

  const remove = (index: number) => setLines((current) => current?.filter((_, i) => i !== index) ?? null);

  return (
    <div className="m-sheet" role="dialog" aria-modal="true" aria-label="Add a conversation from a screenshot">
      <div className="m-sheet-body">
        <div className="m-sheet-head">
          <strong>From a screenshot</strong>
          <span className="spacer" />
          <button className="m-link" onClick={onClose}>
            Cancel
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {!lines && (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Screenshot the conversation in Instagram and send it here. You will see what was read before anything is
              added, and the image is not stored.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void read(file);
              }}
            />
            <button className="m-action primary" disabled={busy} onClick={() => fileRef.current?.click()}>
              {busy ? "Reading…" : "Choose screenshot"}
            </button>
          </>
        )}

        {lines && (
          <>
            <p className="muted" style={{ margin: "0 0 8px" }}>
              {lines.length} message{lines.length === 1 ? "" : "s"} read
              {alreadyInThread > 0 ? ` · ${alreadyInThread} already in the thread, skipped` : ""}. Check who said what,
              fix anything wrong, then add.
            </p>

            {unreadable.length > 0 && (
              <div className="warn-box" style={{ marginBottom: 10 }}>
                <strong>Could not read</strong>
                <ul className="list">
                  {unreadable.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
                <p className="muted" style={{ margin: 0 }}>
                  Nothing was guessed for these. Type them in yourself if they matter.
                </p>
              </div>
            )}

            {lines.map((line, i) => (
              <div key={i} className="shot-line">
                <div className="shot-line-head">
                  <button
                    className="m-chip"
                    aria-pressed={line.sender === "prospect"}
                    onClick={() => update(i, { sender: line.sender === "prospect" ? "setter" : "prospect" })}
                  >
                    {line.sender === "prospect" ? "Them" : "You"}
                  </button>
                  {line.confidence === "low" && <span className="badge warn">unsure</span>}
                  {line.partial && <span className="badge warn">cut off</span>}
                  <span className="spacer" style={{ flex: 1 }} />
                  <button className="m-link" onClick={() => remove(i)} aria-label="Remove this line">
                    Remove
                  </button>
                </div>
                <textarea
                  value={line.text}
                  onChange={(e) => update(i, { text: e.target.value })}
                  rows={Math.min(4, Math.ceil(line.text.length / 44) || 1)}
                  aria-label={`Message ${i + 1}`}
                />
              </div>
            ))}

            <div className="m-sheet-actions">
              <button className="m-action" disabled={busy} onClick={() => setLines(null)}>
                Start over
              </button>
              <button className="m-action primary" disabled={busy || lines.length === 0} onClick={() => void add()}>
                {busy ? "Adding…" : `Add ${lines.length} to thread`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
