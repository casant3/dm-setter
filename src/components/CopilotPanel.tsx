"use client";

import { useEffect, useState } from "react";
import type { AgentResult, AiSuggestion, ConversationChunk, Qualification, SuggestionFeedback } from "@/lib/types";
import { relativeTime } from "@/components/format";

const QUALIFICATION_LABELS: Record<keyof Qualification, string> = {
  fit: "Fit",
  commercial_goal: "Commercial goal",
  media_gap: "Media gap",
  value_established: "Value established",
  service_understanding: "Understands service",
  interest_signal: "Interest signal",
};

function Meter({ label, value }: { label: string; value: number }) {
  const tone = value === 0 ? "zero" : value === 1 ? "partial" : "";
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill ${tone}`} style={{ width: `${(value / 2) * 100}%` }} />
      </span>
      <span className="meter-value">{value}/2</span>
    </div>
  );
}

function Examples({ chunks, kind }: { chunks: ConversationChunk[]; kind: "win" | "loss" }) {
  if (chunks.length === 0) {
    return <p className="muted">No comparable {kind === "win" ? "wins" : "losses"} retrieved for this lead yet.</p>;
  }
  return (
    <>
      {chunks.map((c) => (
        <div key={c.id} className={`example ${kind}`}>
          <div className="example-head">
            <span className={`badge ${kind === "win" ? "good" : "bad"}`}>{c.outcome}</span>
            {c.similarity != null && <span className="muted">{Math.round(c.similarity * 100)}% match</span>}
          </div>
          {c.content}
        </div>
      ))}
    </>
  );
}

export function CopilotPanel({
  result,
  history,
  generating,
  error,
  engine,
  tab,
  onTabChange,
  onGenerate,
  onFeedback,
}: {
  result: AgentResult | null;
  history: AiSuggestion[];
  generating: boolean;
  error: string | null;
  engine: { openai_configured: boolean; setter_model: string } | null;
  tab: "copilot" | "memory";
  onTabChange: (tab: "copilot" | "memory") => void;
  onGenerate: () => void;
  onFeedback: (feedback: SuggestionFeedback, finalMessage: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState<SuggestionFeedback | null>(null);
  const [done, setDone] = useState<SuggestionFeedback | null>(null);

  useEffect(() => {
    setDraft(result?.reviewer.final_reply ?? "");
    setDone(null);
  }, [result?.suggestion_id, result?.reviewer.final_reply]);

  const original = result?.reviewer.final_reply ?? "";
  const wasEdited = draft.trim() !== original.trim();

  const submit = async (feedback: SuggestionFeedback) => {
    if (!result?.suggestion_id) return;
    setSubmitting(feedback);
    try {
      await onFeedback(feedback, feedback === "rejected" ? null : draft.trim());
      setDone(feedback);
    } finally {
      setSubmitting(null);
    }
  };

  const strategy = result?.strategy;
  const gate = result?.gate;

  return (
    <section className="column" aria-label="AI Copilot">
      <div className="column-header">
        <button className="chip" aria-pressed={tab === "copilot"} onClick={() => onTabChange("copilot")}>Copilot</button>
        <button className="chip" aria-pressed={tab === "memory"} onClick={() => onTabChange("memory")}>Memory</button>
        {result && <span className="badge accent">{result.strategy.stage}</span>}
        <span style={{ flex: 1 }} />
        <button className="btn small primary" onClick={onGenerate} disabled={generating}>
          {generating ? <span className="spin" /> : result ? "Regenerate" : "Generate"}
        </button>
      </div>

      <div className="column-body">
        <div className="copilot">
          {error && (
            <div className="banner bad">
              <strong>Generation failed</strong>
              {error}
            </div>
          )}

          {engine && !engine.openai_configured && (
            <div className="banner warn">
              <strong>Offline engine</strong>
              No OPENAI_API_KEY is set, so a deterministic stand-in is writing these replies. Add the key to use{" "}
              {engine.setter_model}.
            </div>
          )}

          {!result && !generating && !error && (
            <p className="muted">
              Run the copilot to get a strategy read on this lead and one exact DM to send. Every suggestion is stored,
              along with whether you used, edited or rejected it.
            </p>
          )}

          {strategy && gate && (
            <>
              {strategy.service_confusion && (
                <div className="banner bad">
                  <strong>SERVICE_CONFUSION — resolve before booking</strong>
                  {strategy.confusion_reason ?? "The prospect misunderstands what is being offered."}
                </div>
              )}

              {!strategy.service_confusion && result?.understanding.commercial_clarity_needed && (
                <div className="banner warn">
                  <strong>They asked about cost before we made the model clear</strong>
                  {result.understanding.commercial_clarity_needed} — say plainly that this is a paid service. This is
                  not a wrong premise about what we are, so do not correct one.
                </div>
              )}

              {result?.audit && !result.audit.ok && (
                <div className="banner bad">
                  <strong>This message fails a deterministic check</strong>
                  {result.audit.violations
                    .filter((v) => v.severity === "hard")
                    .map((v) => v.detail)
                    .join(" · ")}
                </div>
              )}

              {gate.passed ? (
                <div className="banner good">
                  <strong>Call-ready</strong>
                  Qualification is met. Handing to Avo is appropriate now.
                </div>
              ) : (
                <div className="banner warn">
                  <strong>Not call-ready — do not push for a call</strong>
                  {gate.blockers.join(" · ")}
                  {gate.model_said_call_ready && (
                    <div style={{ marginTop: 6, opacity: 0.85 }}>
                      The model wanted to book; the hard gate overruled it.
                    </div>
                  )}
                </div>
              )}

              <div className="card">
                <h3>Suggested DM</h3>
                <textarea
                  className="draft"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Suggested message"
                />
                {wasEdited && <p className="muted" style={{ marginTop: 6 }}>Edited from the original suggestion.</p>}

                {result?.reviewer.issues.length ? (
                  <>
                    <h3 style={{ marginTop: 12 }}>Reviewer caught</h3>
                    <ul className="list">
                      {result.reviewer.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="muted" style={{ marginTop: 8 }}>Reviewer approved the draft as written.</p>
                )}

                <div className="feedback-row">
                  <button
                    className="btn good"
                    onClick={() => submit(wasEdited ? "edited" : "used")}
                    disabled={submitting !== null || !draft.trim()}
                    title="Copies to the thread as sent, and records the feedback"
                  >
                    {submitting === "used" || submitting === "edited" ? <span className="spin" /> : wasEdited ? "Send edited" : "Use as-is"}
                  </button>
                  <button
                    className="btn warn"
                    onClick={() => submit("edited")}
                    disabled={submitting !== null || !wasEdited}
                    title={wasEdited ? "Record this as an edit" : "Change the text first"}
                  >
                    Mark edited
                  </button>
                  <button className="btn bad" onClick={() => submit("rejected")} disabled={submitting !== null}>
                    Reject
                  </button>
                </div>
                {done && (
                  <p className="muted" style={{ marginTop: 8 }}>
                    Recorded as <strong>{done}</strong>
                    {done !== "rejected" ? " and added to the conversation." : "."}
                  </p>
                )}
              </div>

              {result?.plan && (
                <div className="card">
                  <h3>What this message does</h3>
                  <p style={{ margin: "0 0 8px" }}>
                    <span className="pill">{result.plan.move.replace(/_/g, " ")}</span> {result.plan.purpose}
                  </p>
                  <p className="muted" style={{ margin: "0 0 8px" }}>
                    Trying to get back: {result.plan.desired_response}
                  </p>
                  <ul className="list">
                    <li>If they engage: {result.plan.next_if_positive}</li>
                    <li>If they push back: {result.plan.next_if_negative}</li>
                    <li>If they go quiet: {result.plan.next_if_no_reply}</li>
                  </ul>
                  <p className="muted" style={{ margin: 0 }}>
                    {result.audit.words} words · {result.audit.ok ? "passes the style and one-move checks" : "flagged above"}
                  </p>
                </div>
              )}

              {result?.booking && result.booking.state !== "not_ready" && (
                <div className="card">
                  <h3>Booking</h3>
                  <p style={{ margin: "0 0 8px" }}>
                    <span className="pill">{result.booking.state.replace(/_/g, " ")}</span>
                    {result.booking.next_action}
                  </p>
                  <p className="muted" style={{ margin: 0 }}>
                    No-show risk: <strong>{result.booking.no_show_risk}</strong> — {result.booking.no_show_mitigation}
                  </p>
                  {result.booking.no_show_factors.length > 0 && (
                    <ul className="list">
                      {result.booking.no_show_factors.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {result?.read && (
                <div className="card">
                  <h3>Read on them</h3>
                  <p style={{ margin: "0 0 8px" }}>
                    <span className="pill">{result.read.temperature.replace(/_/g, " ")}</span>
                    {result.read.motivation ? (
                      <span className="pill" style={{ marginLeft: 6 }}>
                        motivated by {result.read.motivation.replace(/_/g, " ")}
                      </span>
                    ) : null}
                    {result.read.brush_off ? (
                      <span className="pill" style={{ marginLeft: 6 }}>{result.read.brush_off.replace(/_/g, " ")}</span>
                    ) : null}
                  </p>
                  {result.read.already_answered.length > 0 && (
                    <p className="muted" style={{ margin: 0 }}>
                      Already answered — never ask again: {result.read.already_answered.map((t) => t.replace(/_/g, " ")).join(", ")}
                    </p>
                  )}
                </div>
              )}

              <div className="card">
                <h3>Qualification</h3>
                {(Object.keys(QUALIFICATION_LABELS) as (keyof Qualification)[]).map((key) => (
                  <Meter key={key} label={QUALIFICATION_LABELS[key]} value={strategy.qualification[key]} />
                ))}
                <div className="total-row">
                  <span className="muted">Total (9 needed, every dimension above zero)</span>
                  <span className="total-score">{strategy.total_score}/12</span>
                </div>
                {result?.understanding && (
                  <p className="muted" style={{ marginTop: 8, marginBottom: 0 }}>
                    Service {result.understanding.service_explained ? "explained" : "not yet explained"} by us ·
                    understanding evidenced at {result.understanding.level}/2 from their own words
                    {result.understanding.evidence.length > 0 ? ` (${result.understanding.evidence.length} signal${result.understanding.evidence.length === 1 ? "" : "s"})` : ""}
                  </p>
                )}
              </div>

              <div className="card">
                <h3>Next objective</h3>
                <p style={{ margin: "0 0 8px" }}>{strategy.next_objective}</p>
                <p className="muted" style={{ margin: 0 }}>{strategy.strategy}</p>
                {strategy.missing_information.length > 0 && (
                  <>
                    <h3 style={{ marginTop: 12 }}>Still missing</h3>
                    <ul className="list">
                      {strategy.missing_information.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>

              <div className="card">
                <h3>Similar strong winners</h3>
                <p className="muted" style={{ marginTop: -4 }}>Onboarded or closed — the approach to learn from.</p>
                <Examples chunks={result!.examples.strong_winners} kind="win" />
              </div>

              {result!.examples.partial_wins.length > 0 && (
                <div className="card">
                  <h3>Similar partial wins</h3>
                  <p className="muted" style={{ marginTop: -4 }}>The call happened but did not clearly convert.</p>
                  <Examples chunks={result!.examples.partial_wins} kind="win" />
                </div>
              )}

              <div className="card">
                <h3>Similar failures</h3>
                <p className="muted" style={{ marginTop: -4 }}>What not to repeat — never a template.</p>
                <Examples chunks={result!.examples.failures} kind="loss" />
              </div>

              {result!.examples.voice_examples.length > 0 && (
                <div className="card">
                  <h3>Voice reference</h3>
                  <p className="muted" style={{ marginTop: -4 }}>
                    Phrasing comes from {result!.examples.voice_examples[0].setter_name}; strategy comes from the winners above.
                  </p>
                  {result!.examples.voice_examples.map((c) => (
                    <div key={c.id} className="example">{c.content}</div>
                  ))}
                </div>
              )}

              <div className="card">
                <h3>Credibility in play</h3>
                {result!.credibility_used.length === 0 ? (
                  <p className="muted" style={{ margin: 0 }}>
                    No approved asset is relevant to this prospect, so the writer was told to cite nothing.
                  </p>
                ) : (
                  <ul className="list">
                    {result!.credibility_used.map((c) => (
                      <li key={c.name}>
                        <strong>{c.name}</strong> — {c.approved_claim}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {history.length > 0 && (
            <div className="card">
              <h3>Suggestion history</h3>
              {history.slice(0, 8).map((s) => (
                <div key={s.id} className="example">
                  <div className="example-head">
                    <span
                      className={`badge ${
                        s.feedback === "used" ? "good" : s.feedback === "edited" ? "warn" : s.feedback === "rejected" ? "bad" : ""
                      }`}
                    >
                      {s.feedback ?? "no feedback"}
                    </span>
                    <span className="muted">{relativeTime(s.created_at)} ago</span>
                    <span className="muted">{s.strategy?.total_score}/12</span>
                  </div>
                  {s.final_message_sent && s.final_message_sent !== s.suggested_message ? (
                    <>
                      <div style={{ opacity: 0.7 }}>Suggested: {s.suggested_message}</div>
                      <div style={{ marginTop: 4 }}>Sent: {s.final_message_sent}</div>
                    </>
                  ) : (
                    s.suggested_message
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
