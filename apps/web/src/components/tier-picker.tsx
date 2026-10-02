"use client";

import { useState } from "react";
import { ENTRY_TIERS_CENTS } from "@extract/shared";
import { formatUsdCents } from "@/lib/format-money";

const tiers = ENTRY_TIERS_CENTS.map((t) => t.toString());

export function TierPicker({
  balanceCents,
  onJoin,
  onDebited,
}: {
  balanceCents: string;
  onJoin: (entryTierCents: string, mmRoom: string) => void;
  /** Called after entry fee is debited; refresh session so header balance updates. */
  onDebited?: () => void | Promise<void>;
}) {
  const [picked, setPicked] = useState<string>(tiers[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const balance = BigInt(balanceCents);

  const join = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/matches/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ entryTierCents: picked }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "join_failed");
      await onDebited?.();
      onJoin(picked, data.matchmakingRoomName);
    } catch (e: any) {
      setErr(e?.message ?? "join_failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="rounded-[2rem] border border-white/10 bg-zooa-dark/80 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_20px_40px_-15px_rgba(0,0,0,0.35)] backdrop-blur md:p-8">
        <h1 className="font-display text-2xl tracking-wide text-balance text-[#c4f07a] md:text-3xl">Pick your buy-in</h1>
        <p className="mt-3 max-w-[60ch] text-sm  text-white/60">
          Mass tracks dollars in play. Collect orbs, survive the zone. After lock-in, press{" "}
          <kbd className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-xs">E</kbd> to extract.
        </p>
        <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {tiers.map((t) => {
            const c = BigInt(t);
            const tooPoor = balance < c;
            const active = picked === t;
            return (
              <button
                key={t}
                type="button"
                disabled={tooPoor}
                onClick={() => setPicked(t)}
                className={[
                  "group rounded-2xl border p-4 text-center transition",
                  "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
                  tooPoor
                    ? "cursor-not-allowed border-white/5 bg-white/[0.02] opacity-40"
                    : active
                      ? "border-zooa-lime/70 bg-zooa-lime/10 ring-1 ring-zooa-lime/40"
                      : "border-white/10 bg-white/[0.04] hover:border-zooa-lime/30 hover:bg-white/[0.06] active:scale-[0.98]",
                ].join(" ")}
              >
                <div className="font-mono text-2xl font-bold tabular-nums text-white">{formatUsdCents(c)}</div>
                <div className="mt-1 text-xs uppercase tracking-wider text-white/50">buy-in</div>
              </button>
            );
          })}
        </div>
        {err && (
          <p className="mt-5 text-sm text-rose-300/90" role="alert">
            {err}
          </p>
        )}
        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={busy}
            onClick={join}
            className="font-display inline-flex min-h-[3rem] items-center justify-center rounded-full bg-zooa-lime px-10 text-lg tracking-wide text-zinc-950 transition hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Joining…" : "Find match"}
          </button>
        </div>
      </div>
    </div>
  );
}
