"use client";

import { useState } from "react";

export function GuestPlayDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/guest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname }),
        credentials: "include",
      });
      const data = await r.json();
      if (r.ok && data.status === "ok") {
        onSuccess();
      } else {
        setError(data.error ?? "guest_failed");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "guest_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4">
        <div>
          <h2 className="text-xl font-semibold">Demo (no wallet)</h2>
          <p className="text-sm text-white/60">
            Virtual balance with no real money. Same match flow as registered
            players.
          </p>
        </div>
        <input
          autoFocus
          className="input"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="your_nick"
          minLength={2}
          maxLength={16}
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="btn-ghost text-xs">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="btn-primary text-xs">
            {busy ? "..." : "Play"}
          </button>
        </div>
      </form>
    </div>
  );
}
