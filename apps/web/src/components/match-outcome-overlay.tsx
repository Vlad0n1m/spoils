"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { ROUND_MS } from "@extract/shared";
import type {
  MatchSettlementParticipant,
  MatchSettlementPayload,
  PlayerOutcomePayload,
} from "@extract/shared";
import { formatUsdCents } from "@/lib/format-money";

function fmtRemainRound(clockMs: number): string {
  const ms = Math.max(0, ROUND_MS - clockMs);
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}:${rs.toString().padStart(2, "0")}`;
}

function headline(part: MatchSettlementParticipant | undefined): string {
  if (!part) return "Round settled";
  if (part.isBot) return "Match over";
  const d = BigInt(part.deltaCents);
  if (part.exitType === "extract") {
    if (d > 0n) return "Extract paid off";
    if (d < 0n) return "Extract — net loss";
    return "Extract — even";
  }
  if (part.exitType === "dead") return "Eliminated";
  if (part.exitType === "timeout") {
    if (d > 0n) return "Round complete";
    if (d < 0n) return "Squeezed out — no extract";
    return "Out without extract";
  }
  return "Round complete";
}

function previewHeadline(opts: {
  selfDiedAt: number;
  selfExtractedAt: number;
  selfExitOrder: number;
}): string {
  if (opts.selfExtractedAt > 0) return "Extract complete";
  if (opts.selfDiedAt > 0) return "Eliminated";
  return "Round over";
}

function outcomeToParticipant(o: PlayerOutcomePayload): MatchSettlementParticipant {
  return {
    userId: o.userId,
    isBot: false,
    entryCents: o.entryCents,
    payoutCents: o.payoutCents,
    deltaCents: o.deltaCents,
    exitType: o.exitType,
    exitOrder: o.exitOrder,
  };
}

export function MatchOutcomeOverlay({
  phase,
  settlement,
  playerOutcome,
  userId,
  entryTierCents,
  arenaPhase,
  clockMs,
  selfDiedAt,
  selfExtractedAt,
  selfExitOrder,
  onContinue,
}: {
  phase: "off" | "fading" | "content";
  settlement: MatchSettlementPayload | null;
  playerOutcome: PlayerOutcomePayload | null;
  userId: string;
  entryTierCents: string;
  arenaPhase: "lockin" | "open" | "ended";
  clockMs: number;
  selfDiedAt: number;
  selfExtractedAt: number;
  selfExitOrder: number;
  onContinue: () => void;
}) {
  const [darkOn, setDarkOn] = useState(false);

  useEffect(() => {
    if (phase === "off") {
      setDarkOn(false);
      return;
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setDarkOn(true));
    });
    return () => cancelAnimationFrame(id);
  }, [phase]);

  if (phase === "off") return null;

  const meFromSettle = settlement?.participants.find(
    (p) => p.userId === userId && !p.isBot,
  );
  const meEarly =
    playerOutcome && playerOutcome.userId === userId
      ? outcomeToParticipant(playerOutcome)
      : undefined;
  const me = meFromSettle ?? meEarly;

  const delta = me?.deltaCents ?? null;
  const deltaBi = delta !== null ? BigInt(delta) : null;
  const positive = deltaBi !== null ? deltaBi > 0n : null;
  const negative = deltaBi !== null ? deltaBi < 0n : null;

  const hasNumbers = Boolean(me && (settlement || playerOutcome));
  const onlyWaiting =
    !settlement && !playerOutcome && arenaPhase !== "ended";
  const syncingOnly = !settlement && !playerOutcome && arenaPhase === "ended";
  const provisionalNumbers = Boolean(playerOutcome && !settlement);

  const title = settlement
    ? headline(me)
    : playerOutcome
      ? headline(me)
      : previewHeadline({ selfDiedAt, selfExtractedAt, selfExitOrder });

  const previewExit =
    selfExtractedAt > 0 ? "extract" : selfDiedAt > 0 ? "dead" : "—";

  return (
    <div className="fixed inset-0 z-[100] flex flex-col">
      <div
        className={clsx(
          "pointer-events-none absolute inset-0 bg-[#060509] transition-opacity duration-1000 ease-out",
          darkOn ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
      {phase === "content" && (
        <div className="relative flex min-h-[100dvh] flex-1 items-center justify-center p-4 sm:p-8">
          <div className="pointer-events-auto w-full max-w-md animate-outcome-enter">
            <div
              className={clsx(
                "rounded-[1.75rem] border p-8 shadow-[0_24px_48px_-20px_rgba(0,0,0,0.55)]",
                "border-white/[0.07] bg-ink-800/[0.92] backdrop-blur-md",
                "shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]",
              )}
            >
              <div className="space-y-1">
                <p className="text-[0.65rem] font-medium uppercase tracking-[0.2em] text-white/45">
                  Arena result
                </p>
                <h2
                  className={clsx(
                    "text-2xl font-semibold tracking-tight text-white sm:text-[1.65rem]",
                    settlement && positive === true && "text-emerald-400/95",
                    settlement && negative === true && "text-rose-400/95",
                    !settlement && playerOutcome && positive === true && "text-emerald-400/95",
                    !settlement && playerOutcome && negative === true && "text-rose-400/95",
                  )}
                >
                  {title}
                </h2>
              </div>

              {onlyWaiting && (
                <div className="mt-8 space-y-3 text-sm  text-white/55">
                  <p>
                    The match is still running. You will see your net result in USD as soon as you
                    are out (or connect stayed).
                  </p>
                  <p className="font-mono text-white/70">
                    ~{fmtRemainRound(clockMs)} left on the round clock
                  </p>
                </div>
              )}

              {syncingOnly && (
                <p className="mt-8 text-sm text-white/55">
                  Receiving settlement from the server…
                </p>
              )}

              {provisionalNumbers && playerOutcome?.exitType === "extract" && (
                <p className="mt-6 rounded-xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-xs  text-white/50">
                  Estimate from extractors so far ({playerOutcome.totalExtractorsSoFar}). If more
                  players extract later, the multiplier changes — we will refresh at match end.
                </p>
              )}

              {provisionalNumbers && playerOutcome?.exitType === "dead" && (
                <p className="mt-6 text-xs text-white/45">
                  Stake loss is final; row below is your balance for this queue.
                </p>
              )}

              {hasNumbers && me && (
                <div className="mt-8 space-y-6">
                  {!me.isBot && (
                    <div>
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-xs uppercase tracking-wider text-white/40">Net</p>
                        {provisionalNumbers && (
                          <span className="text-[0.65rem] uppercase tracking-wider text-amber-400/80">
                            Early
                          </span>
                        )}
                        {settlement && (
                          <span className="text-[0.65rem] uppercase tracking-wider text-white/35">
                            Final
                          </span>
                        )}
                      </div>
                      <p
                        className={clsx(
                          "font-mono text-4xl tabular-nums tracking-tight sm:text-5xl",
                          positive === true && "text-emerald-400",
                          negative === true && "text-rose-400",
                          deltaBi === 0n && "text-white/90",
                        )}
                      >
                        {delta !== null && deltaBi !== null ? (
                          <>
                            {deltaBi < 0n ? "" : "+"}
                            {formatUsdCents(delta)}
                          </>
                        ) : (
                          "—"
                        )}
                      </p>
                      <p className="mt-2 max-w-[65ch] text-sm  text-white/45">
                        Stake{" "}
                        <span className="font-mono text-white/70">
                          {formatUsdCents(
                            me.entryCents !== "0" ? me.entryCents : entryTierCents,
                          )}
                        </span>{" "}
                        · Payout{" "}
                        <span className="font-mono text-white/70">
                          {formatUsdCents(me.payoutCents)}
                        </span>
                      </p>
                    </div>
                  )}

                  {settlement && !meFromSettle && (
                    <p className="text-sm text-white/55">
                      Settlement did not include your seat (reconnect or demo session).
                    </p>
                  )}
                </div>
              )}

              {(settlement || playerOutcome || onlyWaiting) && (
                <dl className="mt-6 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-6 text-sm">
                  <div>
                    <dt className="text-white/40">Exit</dt>
                    <dd className="font-mono capitalize text-white/80">
                      {me?.exitType ?? previewExit}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-white/40">Order</dt>
                    <dd className="font-mono text-white/80">
                      {me?.exitOrder != null && me.exitOrder > 0
                        ? `#${me.exitOrder}`
                        : selfExitOrder > 0
                          ? `#${selfExitOrder}`
                          : "—"}
                    </dd>
                  </div>
                </dl>
              )}

              <button
                type="button"
                onClick={onContinue}
                className={clsx(
                  "btn-primary mt-10 w-full rounded-xl py-3 text-sm font-medium",
                  "transition-transform active:scale-[0.98]",
                )}
              >
                Back to lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
