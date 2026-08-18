"use client";

import { useState } from "react";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((payload as { error?: string }).error ?? "Sign-in failed");
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", padding: 24 }}>
      <form className="card" onSubmit={submit} style={{ width: "min(360px, 100%)" }}>
        <h1 style={{ fontSize: 16, margin: "0 0 4px" }}>DM Setter Agent</h1>
        <p className="muted" style={{ marginBottom: 16 }}>
          This workspace contains private prospect conversations.
        </p>
        <label className="form-full">
          Password
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
        <button className="btn primary" type="submit" disabled={busy || !password} style={{ width: "100%", marginTop: 14 }}>
          {busy ? <span className="spin" /> : "Sign in"}
        </button>
      </form>
    </div>
  );
}
