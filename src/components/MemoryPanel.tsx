"use client";

import { useState } from "react";
import type { LeadMemory, MemoryItem } from "@/lib/types";

/**
 * Memory inspection and correction.
 *
 * Model-derived memory is wrong sometimes, and a wrong "fact" quietly steers
 * every future message. Showing provenance and letting a human fix a field —
 * which then becomes verified and immune to automatic overwrite — is what makes
 * long-term memory trustworthy rather than merely persistent.
 */

const EDITABLE_FIELDS = [
  ["businesses", "Businesses"],
  ["goals", "Commercial goals"],
  ["pain_points", "Pain points"],
  ["media_history", "Media history"],
  ["objections", "Objections"],
  ["key_entities", "Key names / products"],
  ["timing_constraints", "Timing"],
  ["followup_commitments", "Commitments"],
] as const;

function ItemList({ items, verified }: { items: MemoryItem[] | undefined; verified: boolean }) {
  if (!items?.length) return <p className="muted" style={{ margin: 0 }}>Nothing recorded.</p>;
  return (
    <ul className="list">
      {items.map((item, i) => (
        <li key={`${item.value}-${i}`}>
          {item.value}
          {item.provenance === "inference" && <span className="badge" style={{ marginLeft: 6 }}>inferred</span>}
          {(item.verified || verified) && <span className="badge good" style={{ marginLeft: 6 }}>verified</span>}
          {item.quote && (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              &ldquo;{item.quote.slice(0, 90)}&rdquo;
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function MemoryPanel({
  memory,
  understanding,
  onCorrect,
}: {
  memory: LeadMemory | null;
  understanding: { level: number; service_explained: boolean; confusion_reason: string | null } | null;
  onCorrect: (patch: Record<string, string[] | number>) => Promise<void>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const verifiedFields = new Set(memory?.verified_fields ?? []);

  const startEdit = (field: string) => {
    const items = (memory?.[field as keyof LeadMemory] as MemoryItem[] | undefined) ?? [];
    setDraft(items.map((i) => i.value).join("\n"));
    setEditing(field);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await onCorrect({ [editing]: draft.split("\n").map((s) => s.trim()).filter(Boolean) });
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  if (!memory) {
    return (
      <div className="card">
        <h3>Long-term memory</h3>
        <p className="muted" style={{ margin: 0 }}>Nothing remembered yet. Memory builds as messages are sent.</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h3>Service state</h3>
        <div className="meter">
          <span className="meter-label">We explained it</span>
          <span className={`badge ${memory.service_explained ? "accent" : ""}`}>
            {memory.service_explained ? `yes (${memory.service_explained_count ?? 1}×)` : "not yet"}
          </span>
        </div>
        <div className="meter" style={{ marginTop: 6 }}>
          <span className="meter-label">They understand it</span>
          <span className={`badge ${(understanding?.level ?? 0) >= 2 ? "good" : (understanding?.level ?? 0) === 1 ? "warn" : "bad"}`}>
            {understanding?.level ?? memory.service_understanding ?? 0}/2
            {verifiedFields.has("service_understanding") ? " · verified" : ""}
          </span>
        </div>
        <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
          Explaining is something we do. Understanding is judged only from the prospect&apos;s own words.
        </p>
        {understanding?.confusion_reason && (
          <p className="error" style={{ marginTop: 8, marginBottom: 0 }}>{understanding.confusion_reason}</p>
        )}
      </div>

      {memory.relationship_summary && (
        <div className="card">
          <h3>Relationship</h3>
          <p style={{ margin: 0 }}>{memory.relationship_summary}</p>
        </div>
      )}

      {EDITABLE_FIELDS.map(([field, label]) => (
        <div className="card" key={field}>
          <h3>
            {label}
            <button
              className="btn small ghost"
              style={{ float: "right", marginTop: -4 }}
              onClick={() => (editing === field ? setEditing(null) : startEdit(field))}
            >
              {editing === field ? "Cancel" : "Correct"}
            </button>
          </h3>

          {editing === field ? (
            <>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                style={{ width: "100%", minHeight: 90 }}
                aria-label={`Correct ${label}`}
              />
              <p className="muted" style={{ margin: "6px 0" }}>One per line. Saving marks this field verified so automatic updates leave it alone.</p>
              <button className="btn small primary" onClick={save} disabled={busy}>
                {busy ? <span className="spin" /> : "Save correction"}
              </button>
            </>
          ) : (
            <ItemList items={memory[field] as MemoryItem[] | undefined} verified={verifiedFields.has(field)} />
          )}
        </div>
      ))}

      <div className="card">
        <h3>Already covered</h3>
        <p className="muted" style={{ margin: "0 0 6px" }}>Questions asked</p>
        <ItemList items={memory.questions_already_asked} verified={verifiedFields.has("questions_already_asked")} />
        <p className="muted" style={{ margin: "10px 0 6px" }}>CTAs used</p>
        <ItemList items={memory.ctas_already_used} verified={false} />
      </div>
    </>
  );
}
