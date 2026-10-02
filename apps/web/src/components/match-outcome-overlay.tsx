"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import {
  BREAK_CHANCE_ON_DEATH,
  type ItemRef,
  type MatchSettlementPayload,
  type OutcomeMsg,
} from "@extract/shared";
import { fmtClock } from "@/lib/items-ui";
import { ItemTile } from "./item-tile";

/** Delay before the result card appears, so the player sees the moment of death / extraction. */
const CONTENT_DELAY_MS = 900;

export function MatchOutcomeOverlay({
  visible,
  outcome,
  settlement,
  raidEnded,
  disconnected,
  onContinue,
}: {
  visible: boolean;
  /** This player's personal result (S2C.OUTCOME). */
  outcome: OutcomeMsg | null;
  settlement: MatchSettlementPayload | null;
  raidEnded: boolean;
  disconnected: boolean;
  onContinue: () => void;
}) {
  const [dim, setDim] = useState(false);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    if (!visible) {
      setDim(false);
      setShowContent(false);
      return;
    }
    // Two frames so the opacity transition actually runs from 0.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setDim(true));
    });
    const t = window.setTimeout(() => setShowContent(true), CONTENT_DELAY_MS);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(t);
    };
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col">
      <div
        className={clsx(
          "pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(6,8,12,0.55),rgba(6,8,12,0.92))] transition-opacity duration-700 ease-out",
          dim ? "opacity-100" : "opacity-0",
        )}
        aria-hidden
      />
      {showContent && (
        <div className="relative flex min-h-[100dvh] flex-1 items-center justify-center overflow-y-auto p-4 sm:p-8">
          <div className="w-full max-w-lg animate-outcome-enter">
            {outcome ? (
              <ResultCard outcome={outcome} settlement={settlement} onContinue={onContinue} />
            ) : (
              <WaitingCard raidEnded={raidEnded} disconnected={disconnected} onContinue={onContinue} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const EXIT_STYLE = {
  extract: { title: "Extracted!", color: "text-zooa-lime", band: "bg-zooa-lime" },
  dead: { title: "Eliminated", color: "text-rose-400", band: "bg-rose-500" },
  timeout: { title: "Time's up", color: "text-amber-300", band: "bg-amber-400" },
} as const;

function ResultCard({
  outcome,
  settlement,
  onContinue,
}: {
  outcome: OutcomeMsg;
  settlement: MatchSettlementPayload | null;
  onContinue: () => void;
}) {
  const style = EXIT_STYLE[outcome.exit];
  const humans = settlement?.participants.filter((p) => !p.isBot) ?? [];
  const raidersOut = settlement?.participants.filter((p) => p.exitType === "extract").length ?? 0;

  return (
    <section className="toon-panel overflow-hidden bg-[#161b28]/95 p-0" aria-live="polite">
      <div className={clsx("h-3 border-b-[3px] border-black", style.band)} aria-hidden />
      <div className="p-6 sm:p-8">
        <p className="text-xs uppercase tracking-[0.25em] text-white/50">Raid result</p>
        <h2 className={clsx("toon-text mt-2 text-5xl tracking-wide sm:text-6xl", style.color)}>{style.title}</h2>
        <p className="mt-3 text-lg tracking-wide text-white/85">{subtitle(outcome)}</p>

        <div className="mt-6 space-y-5">
          {outcome.exit === "extract" && (
            <ItemSection
              title="Brought out"
              items={outcome.extracted}
              empty="Nothing valuable this time — the free kit doesn't count. Loot chests for weapons and armor."
            />
          )}

          {outcome.exit === "dead" && (
            <>
              {outcome.dropped.length === 0 && outcome.lost.length === 0 ? (
                <p className="text-sm leading-relaxed text-white/60">
                  You only carried the free kit, so nothing was lost.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <ItemSection title="Dropped for others" items={outcome.dropped} empty="Nothing dropped." />
                  <ItemSection title="Broke" items={outcome.lost} empty="Nothing broke." dim />
                </div>
              )}
              <p className="rounded-xl border-2 border-black/60 bg-black/30 px-3 py-2 text-xs leading-relaxed text-white/60">
                On death every item has a {Math.round(BREAK_CHANCE_ON_DEATH * 100)}% chance to break; the rest drops by
                your body for anyone to loot. The free pistol never drops.
              </p>
            </>
          )}

          {outcome.exit === "timeout" && (
            <ItemSection
              title="Lost on the map"
              items={outcome.lost}
              empty="You only carried the free kit, so nothing was lost."
              dim
            />
          )}
        </div>

        <dl className="mt-6 grid grid-cols-3 gap-2 border-t-[3px] border-black/50 pt-5 text-center">
          <Stat label="Kills" value={String(outcome.kills)} />
          <Stat label={outcome.exit === "extract" ? "Out at" : "Survived"} value={fmtClock(outcome.atMs)} />
          <Stat
            label="Extracted"
            value={settlement ? `${raidersOut}/${settlement.participants.length}` : "…"}
            title={
              settlement
                ? `${humans.filter((p) => p.exitType === "extract").length} of ${humans.length} human raiders got out`
                : "Raid still running"
            }
          />
        </dl>

        <button type="button" onClick={onContinue} className="toon-btn mt-8 min-h-14 w-full text-xl tracking-wide">
          Back to lobby
        </button>
      </div>
    </section>
  );
}

function subtitle(o: OutcomeMsg): string {
  if (o.exit === "extract") return "Everything you carried is yours to keep.";
  if (o.exit === "dead") return o.killedBy ? `Killed by ${o.killedBy}` : "You died.";
  return "You were still on the map when the raid ended. Everything you carried is lost.";
}

function ItemSection({
  title,
  items,
  empty,
  dim,
}: {
  title: string;
  items: ItemRef[];
  empty: string;
  dim?: boolean;
}) {
  return (
    <div>
      <h3 className="text-sm uppercase tracking-[0.18em] text-white/55">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-2 text-sm leading-relaxed text-white/50">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-3">
          {items.map((it) => (
            <li key={it.uid}>
              <ItemTile item={it} dim={dim} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div title={title}>
      <dt className="text-[0.65rem] uppercase tracking-[0.18em] text-white/45">{label}</dt>
      <dd className="toon-text-thin mt-1 text-2xl tabular-nums text-white">{value}</dd>
    </div>
  );
}

function WaitingCard({
  raidEnded,
  disconnected,
  onContinue,
}: {
  raidEnded: boolean;
  disconnected: boolean;
  onContinue: () => void;
}) {
  const title = disconnected ? "Connection lost" : raidEnded ? "Raid over" : "Counting your loot…";
  const body = disconnected
    ? "You were disconnected from the raid. Its result is saved when the raid ends."
    : "Waiting for the server to send your result.";
  return (
    <section className="toon-panel bg-[#161b28]/95 p-8 text-center">
      <h2 className="toon-text text-4xl tracking-wide text-white">{title}</h2>
      <p className="mt-4 text-sm leading-relaxed text-white/60">{body}</p>
      {!disconnected && (
        <div className="mx-auto mt-6 h-10 w-10 animate-spin rounded-full border-4 border-black border-t-zooa-lime" aria-hidden />
      )}
      <button type="button" onClick={onContinue} className="toon-btn mt-8 min-h-12 w-full text-lg tracking-wide">
        Back to lobby
      </button>
    </section>
  );
}
