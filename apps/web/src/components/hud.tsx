"use client";

import { memo } from "react";
import {
  EXTRACT_CHANNEL_MS,
  LOCKIN_MS,
  ROUND_MS,
} from "@extract/shared";
import { formatMassUnitsAsUsd } from "@/lib/format-money";
import type { HudSnapshot } from "./battle-screen";

function fmtClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function pingTone(ms: number) {
  if (ms < 100) return "text-emerald-400/90";
  if (ms < 200) return "text-amber-300/90";
  return "text-rose-300/90";
}

export const Hud = memo(function Hud({
  snapshot,
  pingMs,
  onForfeit,
}: {
  snapshot: HudSnapshot;
  /** Round-trip to game server (WebSocket), updated ~1.5s */
  pingMs: number | null;
  onForfeit: () => void;
}) {
  const totalLeft = ROUND_MS - snapshot.clockMs;
  const phaseLabel =
    snapshot.phase === "lockin"
      ? `LOCK-IN ${fmtClock(LOCKIN_MS - snapshot.clockMs)}`
      : snapshot.phase === "open"
        ? `OPEN — press E to extract (${fmtClock(totalLeft)})`
        : "ROUND ENDED";
  const extracting =
    snapshot.selfExtractStartedAt > 0 && snapshot.selfExtractedAt === 0;
  const extractElapsed = extracting
    ? snapshot.clockMs - snapshot.selfExtractStartedAt
    : 0;
  const extractPct = Math.min(100, (extractElapsed / EXTRACT_CHANNEL_MS) * 100);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 p-4 flex justify-between gap-4 text-white">
      <div className="card pointer-events-auto bg-ink-800/85 px-4 py-3 space-y-2 max-w-[min(100%,20rem)]">
        <div className="text-xs uppercase tracking-wide text-white/60">
          {phaseLabel}
        </div>
        <div
          className="text-[11px] font-mono text-white/50 tabular-nums"
          title="Round-trip time to the game server (your inputs and world updates)"
        >
          Ping:{" "}
          {pingMs == null ? (
            <span className="text-white/35">—</span>
          ) : (
            <span className={pingTone(pingMs)}>{pingMs} ms</span>
          )}
        </div>
        <div className="text-2xl font-mono text-zooa-lime/95">
          {formatMassUnitsAsUsd(snapshot.selfMassUnits)}
        </div>
        {snapshot.selfDiedAt > 0 && snapshot.selfExtractedAt === 0 && (
          <div className="text-sm text-rose-400/90">Eliminated</div>
        )}
        {snapshot.selfExtractedAt > 0 && (
          <div className="text-sm text-emerald-400/90">
            Extracted (#{snapshot.selfExitOrder})
          </div>
        )}
        {extracting && (
          <div className="space-y-1">
            <div className="text-xs text-white/60">Extracting...</div>
            <div className="h-2 w-48 rounded bg-ink-600 overflow-hidden">
              <div
                className="h-full bg-emerald-500/80 transition-all"
                style={{ width: `${extractPct}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="card pointer-events-auto bg-ink-800/85 px-3 py-2 text-xs space-y-1 text-white/70">
        <div>
          <kbd className="rounded bg-ink-600 px-1.5">mouse</kbd> aim
        </div>
        <div>
          <kbd className="rounded bg-ink-600 px-1.5">LMB</kbd> boost
        </div>
        <div>
          <kbd className="rounded bg-ink-600 px-1.5">E</kbd> extract
        </div>
        <button
          onClick={onForfeit}
          className="btn-ghost mt-2 text-[10px] py-1"
        >
          Leave (forfeit)
        </button>
      </div>
    </div>
  );
});
