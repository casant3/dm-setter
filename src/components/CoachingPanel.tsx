"use client";

import { useCallback, useEffect, useState } from "react";
import type { CoachingExample, SetterPreference } from "@/lib/types";

/**
 * The coaching review queue.
 *
 * Rules inferred from live edits and examples pulled out of a ChatGPT export
 * arrive here and do nothing at all until someone approves them. Approving is
 * also where the wording gets fixed — an inferred rule is a guess about what an
 * edit meant, and the person who made the edit is the only one who knows.
 */

type Payload = { preferences: SetterPreference[]; examples: CoachingExample[]; pending: number };

/** The last attempt in a correction chain — the natural starting point for approval. */
function lastRevision(example: CoachingExample): string | null {
  const revisions = example.revisions ?? [];
  return revisions.length > 0 ? revisions[revisions.length - 1].reply : null;
}

const TIERS = [
  "1. Rules from Cassey — override everything below",
  "2. Approved coaching examples — the shape of the reply",
  "3. Messages Cassey actually sent — the live voice",
  "4. Historical messages — tone reference",
  "5. Winning conversations — approach, never wording",
  "6. The general instructions — the fallback",
];

export function CoachingPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Payload | null>(null);
  const [tab, setTab] = useState<"pending" | "active" | "add" | "import">("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newRule, setNewRule] = useState("");
  const [exportText, setExportText] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/coaching");
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Could not load the coaching layer");
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the coaching layer");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, kind: "rule" | "example", decision: "approve" | "reject", text?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/coaching/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          decision,
          ...(kind === "rule" ? { rule: text } : { approved_reply: text }),
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Update failed");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    if (!newRule.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/coaching", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "rule", rule: newRule, priority: 10 }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Could not save the rule");
      setNewRule("");
      setNote("Rule saved and active.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the rule");
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const parsed = JSON.parse(exportText);
      const res = await fetch("/api/coaching/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ export: parsed }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error ?? "Import failed");
      setNote(`${payload.imported} candidates queued for review. None of them affect a suggestion until approved.`);
      setExportText("");
      setTab("pending");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not parse as JSON");
    } finally {
      setBusy(false);
    }
  };

  const pendingRules = (data?.preferences ?? []).filter((p) => p.status === "pending_review");
  const pendingExamples = (data?.examples ?? []).filter((e) => e.status === "pending_review");
  const activeRules = (data?.preferences ?? []).filter((p) => p.status === "active");
  const activeExamples = (data?.examples ?? []).filter((e) => e.status === "approved");

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Coaching" onClick={onClose}>
      <div className="dialog" style={{ width: "min(1000px, 100%)" }} onClick={(e) => e.stopPropagation()}>
        <h2>Coaching</h2>
        <p className="muted">
          How you want messages written, in the order the setter applies it. Nothing learned from an edit or an import
          is used until you approve it here.
        </p>

        <div className="lead-filters" style={{ padding: "0 0 12px" }}>
          <button className="chip" aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>
            Awaiting review ({pendingRules.length + pendingExamples.length})
          </button>
          <button className="chip" aria-pressed={tab === "active"} onClick={() => setTab("active")}>
            In force ({activeRules.length + activeExamples.length})
          </button>
          <button className="chip" aria-pressed={tab === "add"} onClick={() => setTab("add")}>Add a rule</button>
          <button className="chip" aria-pressed={tab === "import"} onClick={() => setTab("import")}>Import</button>
        </div>

        {error && <p className="error">{error}</p>}
        {note && <p className="muted">{note}</p>}

        {tab === "pending" && (
          <div className="preview-list" style={{ maxHeight: 460 }}>
            {pendingRules.length + pendingExamples.length === 0 && (
              <p className="muted">Nothing waiting. Edits you make to suggestions show up here as proposed rules.</p>
            )}

            {pendingRules.map((rule) => (
              <div key={rule.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                <span className="pill">{rule.source.replace(/_/g, " ")}</span>
                {rule.applies_to && <span className="pill">{rule.applies_to}</span>}
                <textarea
                  value={drafts[rule.id] ?? rule.rule}
                  onChange={(e) => setDrafts({ ...drafts, [rule.id]: e.target.value })}
                  style={{ width: "100%", minHeight: 60, marginTop: 6 }}
                  aria-label="Proposed rule"
                />
                {rule.evidence ? (
                  <details>
                    <summary className="muted">What this was inferred from</summary>
                    <p className="muted" style={{ whiteSpace: "pre-wrap", margin: "6px 0" }}>
                      Suggested: {String((rule.evidence as { suggested?: string }).suggested ?? "")}
                      {"\n\n"}
                      You sent: {String((rule.evidence as { sent?: string }).sent ?? "")}
                    </p>
                  </details>
                ) : null}
                <div className="dialog-actions">
                  <button className="btn bad" disabled={busy} onClick={() => decide(rule.id, "rule", "reject")}>
                    Discard
                  </button>
                  <button
                    className="btn good"
                    disabled={busy}
                    onClick={() => decide(rule.id, "rule", "approve", drafts[rule.id] ?? rule.rule)}
                  >
                    Apply from now on
                  </button>
                </div>
              </div>
            ))}

            {pendingExamples.map((example) => (
              <div key={example.id} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
                <span className="pill">{example.source.replace(/_/g, " ")}</span>
                <span className="pill">{example.kind?.replace(/_/g, " ") ?? "example"}</span>
                {(example.tags ?? []).map((tag) => (
                  <span key={tag} className="pill">
                    {tag.replace(/_/g, " ")}
                  </span>
                ))}
                <p className="muted" style={{ margin: "6px 0 2px" }}>{example.situation}</p>
                {example.prospect_message && (
                  <p className="muted" style={{ margin: "0 0 6px" }}>They said: {example.prospect_message.slice(0, 240)}</p>
                )}

                {/* The correction itself: what was written, and what was wrong with it. */}
                {(example.revisions ?? []).length > 0 ? (
                  <ol className="list" style={{ margin: "0 0 8px" }}>
                    {example.revisions.map((revision, i) => (
                      <li key={i}>
                        <div style={{ opacity: 0.75 }}>{revision.reply}</div>
                        {revision.feedback && <div className="muted">You said: “{revision.feedback}”</div>}
                      </li>
                    ))}
                  </ol>
                ) : (
                  example.rejected_reply && (
                    <p className="muted" style={{ margin: "0 0 8px" }}>
                      Rejected: {example.rejected_reply.slice(0, 300)}
                      {example.operator_feedback ? ` — you said “${example.operator_feedback}”` : ""}
                    </p>
                  )
                )}

                <textarea
                  value={drafts[example.id] ?? example.approved_reply ?? lastRevision(example) ?? ""}
                  onChange={(e) => setDrafts({ ...drafts, [example.id]: e.target.value })}
                  style={{ width: "100%", minHeight: 80 }}
                  placeholder="The wording you want followed in this situation"
                  aria-label="Approved reply"
                />
                <div className="dialog-actions">
                  <button className="btn bad" disabled={busy} onClick={() => decide(example.id, "example", "reject")}>
                    Discard
                  </button>
                  <button
                    className="btn good"
                    disabled={busy}
                    onClick={() =>
                      decide(
                        example.id,
                        "example",
                        "approve",
                        drafts[example.id] ?? example.approved_reply ?? lastRevision(example) ?? "",
                      )
                    }
                  >
                    Use as an example
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {tab === "active" && (
          <div className="preview-list" style={{ maxHeight: 460 }}>
            <h3 style={{ fontSize: 13 }}>Order of precedence</h3>
            <ul className="list">
              {TIERS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <h3 style={{ fontSize: 13 }}>Your rules</h3>
            {activeRules.length === 0 && <p className="muted">No rules yet.</p>}
            <ul className="list">
              {activeRules.map((r) => (
                <li key={r.id}>
                  {r.rule}
                  <button className="btn small ghost" style={{ marginLeft: 8 }} disabled={busy} onClick={() => decide(r.id, "rule", "reject")}>
                    Retire
                  </button>
                </li>
              ))}
            </ul>
            <h3 style={{ fontSize: 13 }}>Approved examples</h3>
            {activeExamples.length === 0 && <p className="muted">No examples yet.</p>}
            {activeExamples.map((e) => (
              <div key={e.id} className="example">
                <span className="muted">{e.situation}</span>
                <div>{e.approved_reply}</div>
                {e.operator_feedback && <div className="muted">Instead of: “{e.operator_feedback}”</div>}
              </div>
            ))}
          </div>
        )}

        {tab === "add" && (
          <>
            <p className="muted">
              A rule here overrides everything the setter has learned. Write it the way you would say it to a person:
              &ldquo;stop opening with &lsquo;quick one&rsquo;&rdquo;, &ldquo;never mention price before they do&rdquo;.
            </p>
            <textarea
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              style={{ width: "100%", minHeight: 100 }}
              aria-label="New rule"
            />
            <div className="dialog-actions">
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn good" disabled={busy || !newRule.trim()} onClick={addRule}>Save rule</button>
            </div>
          </>
        )}

        {tab === "import" && (
          <>
            <p className="muted">
              Paste a ChatGPT export. Everything found lands in the review queue — the export contains drafts and
              rejected ideas as well as messages you stood behind, and nothing in the file tells them apart.
            </p>
            <textarea
              value={exportText}
              onChange={(e) => setExportText(e.target.value)}
              style={{ width: "100%", minHeight: 200, fontFamily: "var(--mono)", fontSize: 12 }}
              aria-label="ChatGPT export JSON"
            />
            <div className="dialog-actions">
              <button className="btn ghost" onClick={onClose}>Close</button>
              <button className="btn" disabled={busy || !exportText.trim()} onClick={runImport}>
                {busy ? <span className="spin" /> : "Queue for review"}
              </button>
            </div>
          </>
        )}

        {(tab === "pending" || tab === "active") && (
          <div className="dialog-actions">
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        )}
      </div>
    </div>
  );
}
