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
        setError(
          data.error === "bad_body"
            ? "2–16 characters: letters, numbers, underscores."
            : (data.error ?? "guest_failed"),
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "guest_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
      <form onSubmit={submit} className="toon-panel w-full max-w-md space-y-5 bg-[#161b28] p-6 md:p-8">
        <div>
          <h2 className="toon-text text-3xl tracking-wide text-zooa-lime">Play as guest</h2>
          <p className="font-body mt-3 text-base leading-relaxed text-white/70">
            Pick a nickname and drop in with the free kit. Guest results are not tied to an account.
          </p>
        </div>
        <input
          autoFocus
          className="w-full rounded-2xl border-[3px] border-black bg-white px-4 py-3 text-lg tracking-wide text-black placeholder:text-black/35 focus:outline-none focus:ring-4 focus:ring-zooa-lime/60"
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder="your_nick"
          minLength={2}
          maxLength={16}
          pattern="[a-zA-Z0-9_]+"
          required
        />
        {error && (
          <p className="font-body text-sm font-semibold text-rose-300" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="toon-btn-ghost min-h-11 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="toon-btn min-h-11 text-base tracking-wide">
            {busy ? "…" : "Let's go"}
          </button>
        </div>
      </form>
    </div>
  );
}
