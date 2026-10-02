"use client";

/**
 * End-of-raid overlay v2: extracted gear (to the stash), the junk auto-sell receipt (CR lines,
 * coin tick per line), dog tags, broken items (lost to the pool) and items left in your body,
 * kills and time. Driven by S2C.OUTCOME (OutcomeMsg) and S2C.SETTLED (MatchSummaryMsg); the web
 * API's final credits (after applyExit: autosell mult, dog-tag repeat rule) can be passed later
 * through `finalCredits`, and the receipt re-totals itself.
 */

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { BREAK_CHANCE_ON_DEATH, type MatchSummaryMsg, type OutcomeMsg, type SoldLine } from "@extract/shared";
import { playUi } from "@/game/audio/ui-sounds";
import { buildReceipt, fmtClock } from "@/lib/items-ui";
import type { RoomExit } from "@/lib/room-exit";
import { DogTagRow, ItemStrip, SellReceipt } from "./inventory/outcome-receipt";

/** Delay before the result card appears, so the player sees the moment of death / extraction. */
const CONTENT_DELAY_MS = 900;

export interface FinalCredits {
  /** CR actually credited by applyExit. */
  credits: number;
  /** Autosell multiplier applied. */
  mult: number;
  /** Final receipt lines, when the API returns them. */
  lines?: SoldLine[];
}

export interface MatchOutcomeOverlayProps {
  visible: boolean;
  /** This player's personal result (S2C.OUTCOME). */
  outcome: OutcomeMsg | null;
  /** End-of-match scoreboard (S2C.SETTLED). */
  settlement: MatchSummaryMsg | null;
  raidEnded: boolean;
  disconnected: boolean;
  /** Why the room dropped us, when it was a kick (e.g. joined from another tab). */
  kick?: RoomExit | null;
  /** Final numbers from the web API after settlement; null/undefined = show the server estimate. */
  finalCredits?: FinalCredits | null;
  /** Coin sound per receipt line; defaults to the shared UI coin sound. Pass a no-op to mute. */
  onCoin?: () => void;
  onContinue: () => void;
}

export function MatchOutcomeOverlay({
  visible,
  outcome,
  settlement,
  raidEnded,
  disconnected,
  kick = null,
  finalCredits = null,
  onCoin = defaultCoin,
  onContinue,
}: MatchOutcomeOverlayProps) {
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
        // m-auto instead of items-center: a receipt taller than the screen must scroll from its top.
        <div className="relative flex min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="m-auto w-full max-w-xl animate-outcome-enter">
            {outcome ? (
              <ResultCard
                outcome={outcome}
                settlement={settlement}
                finalCredits={finalCredits}
                onCoin={onCoin}
                onContinue={onContinue}
              />
            ) : (
              <WaitingCard raidEnded={raidEnded} disconnected={disconnected} kick={kick} onContinue={onContinue} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function defaultCoin() {
  playUi("coin");
}

const EXIT_STYLE = {
  extract: { title: "Extracted!", color: "text-zooa-lime", band: "bg-zooa-lime" },
  dead: { title: "Eliminated", color: "text-rose-400", band: "bg-rose-500" },
  timeout: { title: "Time's up", color: "text-amber-300", band: "bg-amber-400" },
} as const;

function ResultCard({
  outcome,
  settlement,
  finalCredits,
  onCoin,
  onContinue,
}: {
  outcome: OutcomeMsg;
  settlement: MatchSummaryMsg | null;
  finalCredits: FinalCredits | null;
  onCoin: () => void;
  onContinue: () => void;
}) {
  const style = EXIT_STYLE[outcome.exit];
  const humans = settlement?.participants.filter((p) => !p.isBot) ?? [];
  const raidersOut = settlement?.participants.filter((p) => p.exitType === "extract").length ?? 0;
  const receipt = useMemo(
    () => buildReceipt(outcome.extracted, outcome.sold, outcome.guest ? null : finalCredits),
    [outcome.extracted, outcome.sold, outcome.guest, finalCredits],
  );

  return (
    <section className="toon-panel overflow-hidden bg-[#161b28]/95 p-0" aria-live="polite">
      <div className={clsx("h-3 border-b-[3px] border-black", style.band)} aria-hidden />
      <div className="p-6 sm:p-8">
        <p className="text-xs uppercase tracking-[0.25em] text-white/50">Raid result</p>
        <h2 className={clsx("toon-text mt-2 text-5xl tracking-wide sm:text-6xl", style.color)}>{style.title}</h2>
        <p className="font-body mt-3 text-lg font-semibold leading-snug text-white/85">{subtitle(outcome)}</p>

        <div className="mt-6 space-y-5">
          {outcome.exit === "extract" && (
            <>
              <ItemStrip
                title={outcome.guest ? "Brought out (not kept as guest)" : "To your stash"}
                items={receipt.kept}
                tone={outcome.guest ? "dim" : "normal"}
                empty="No gear this time — the free kit never counts. Search bodies and crates for weapons and armor."
              />
              <SellReceipt receipt={receipt} guest={outcome.guest} onCoin={onCoin} />
              <DogTagRow names={receipt.dogTags} />
            </>
          )}

          {outcome.exit === "dead" && (
            <>
              {outcome.dropped.length === 0 && outcome.lost.length === 0 ? (
                <p className="font-body text-base leading-relaxed text-white/70">
                  You only carried the free kit, so nothing was lost.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                  <ItemStrip title="Broken — lost" items={outcome.lost} tone="broken" empty="Nothing broke. Lucky!" />
                  <ItemStrip
                    title="Left in your body"
                    items={outcome.dropped}
                    empty="Nothing left behind."
                    note="Anyone who searches your body can take these."
                  />
                </div>
              )}
              <p className="font-body rounded-xl border-2 border-black/60 bg-black/30 px-3 py-2 text-sm leading-relaxed text-white/70">
                On death each weapon, armor and backpack has a {Math.round(BREAK_CHANCE_ON_DEATH * 100)}% chance to
                break. Everything else stays in your body, along with your dog tag. The free kit never drops.
              </p>
            </>
          )}

          {outcome.exit === "timeout" && (
            <ItemStrip
              title="Lost on the map"
              items={outcome.lost}
              tone="dim"
              empty="You only carried the free kit, so nothing was lost."
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
  if (o.exit === "extract") return o.guest ? "You made it out! Register to keep what you find." : "Everything you carried is yours to keep.";
  if (o.exit === "dead") return o.killedBy ? `Killed by ${o.killedBy}` : "You died.";
  return "You were still on the map when the raid ended. Everything you carried is lost.";
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
  kick,
  onContinue,
}: {
  raidEnded: boolean;
  disconnected: boolean;
  kick: RoomExit | null;
  onContinue: () => void;
}) {
  const title = kick ? kick.title : disconnected ? "Connection lost" : raidEnded ? "Raid over" : "Counting your loot…";
  const body = kick
    ? kick.message
    : disconnected
      ? "You were disconnected from the raid. Its result is saved when the raid ends."
      : "Waiting for the server to send your result.";
  return (
    <section className="toon-panel bg-[#161b28]/95 p-8 text-center">
      <h2 className="toon-text text-4xl tracking-wide text-white">{title}</h2>
      <p className="font-body mt-4 text-base leading-relaxed text-white/70">{body}</p>
      {!disconnected && (
        <div className="mx-auto mt-6 h-10 w-10 animate-spin rounded-full border-4 border-black border-t-zooa-lime" aria-hidden />
      )}
      <button type="button" onClick={onContinue} className="toon-btn mt-8 min-h-12 w-full text-lg tracking-wide">
        Back to lobby
      </button>
    </section>
  );
}
