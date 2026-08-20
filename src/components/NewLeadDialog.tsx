"use client";

import { useState } from "react";
import { PRIORITIES, type NewLeadInput, type Priority } from "@/lib/types";
import { PRIORITY_LABELS } from "@/components/format";

export function NewLeadDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: NewLeadInput) => Promise<void>;
}) {
  const [form, setForm] = useState<NewLeadInput>({ instagram_handle: "", priority: "medium" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof NewLeadInput) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onCreate({ ...form, instagram_handle: form.instagram_handle.trim().replace(/^@/, "") });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the lead");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Add a lead" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Add a lead</h2>
        <p className="muted">
          Only the handle is required. Everything else feeds qualification, so fill in what you already know.
        </p>

        <div className="form-grid">
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

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !form.instagram_handle.trim()}>
            {busy ? <span className="spin" /> : "Add lead"}
          </button>
        </div>
      </form>
    </div>
  );
}
