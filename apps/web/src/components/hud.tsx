"use client";

import { AudioSettingsButton } from "./audio-settings";
import { useTouchMode } from "./use-touch-mode";
import { touchIconSvg } from "@/game/touch-icons";
import { EXTRACT_PILL_MAX_W, EXTRACT_PILL_MAX_W_DESKTOP, MINIMAP_MARGIN, minimapSize } from "@/game/hud-layout";
import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { BREAK_CHANCE_ON_DEATH, GRENADE, HEAL, WEAPONS, XP, itemDef, type WeaponId } from "@extract/shared";
import { BAG_FULL_HINT, PX_PER_METER, WIPE_URGENT_MS, bossToastText, deepEqual, extractPillSlice, extractXpLeftS, shallowEqual, wipeWarnText, type HudStore } from "@/game/hud";
import type { HudSelf, HudSlot, HudSnapshot, KillFeedEntry, XpGain } from "@/game/types";
import { NPC_TAG_COLOR, cssHex, killFeedNames, npcLabels, type FeedName } from "@/game/npc-labels";
import { fmtClock, fmtCr, isKillWeapon, killWeaponIcon, killWeaponName, rarityHex, rarityName, armorIcon, weaponIcon } from "@/lib/items-ui";

/** Kill feed lines stay this long (match clock). */
const KILL_FEED_TTL_MS = 7_000;
const KILL_FEED_MAX = 5;
/** Boss toast ("BOSS EVENT · Foreman holds the Grain Elevator") stays this long. */
const BOSS_TOAST_MS = 6_000;
/** New key: the panel is collapsed by default now, so an old stored "open" must not reopen it. */
const HELP_STORAGE_KEY = "extract:hud-controls-open";

/**
 * Reads a slice of the HUD store. The component re-renders only when `isEqual` says the slice
 * changed, so a 30 Hz renderer and a 10 Hz store publish cost nothing for panels whose numbers
 * did not move. `select` must be a pure function of the snapshot.
 */
export function useHud<T>(
  store: HudStore,
  select: (s: HudSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const cache = useRef<{ snap: HudSnapshot; value: T } | null>(null);
  const get = () => {
    const snap = store.getSnapshot();
    const c = cache.current;
    if (c && c.snap === snap) return c.value;
    const value = select(snap);
    if (c && isEqual(c.value, value)) {
      c.snap = snap;
      return c.value;
    }
    cache.current = { snap, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

/**
 * Calls `frame(clockMs)` on every animation frame while mounted, with the store's extrapolated
 * match clock. Used by progress bars and countdowns to animate through refs without React.
 */
function useClockFrames(store: HudStore, frame: (clockMs: number) => void) {
  const ref = useRef(frame);
  // Latest-callback ref: the loop below is started once per store, but must see new props.
  useEffect(() => {
    ref.current = frame;
  });
  useEffect(() => {
    let id = 0;
    const loop = () => {
      ref.current(store.clockNow());
      id = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(id);
  }, [store]);
}

const isInPlay = (s: HudSnapshot) => Boolean(s.self && s.self.alive && s.self.extractedAt === 0);
const mapOpenSlice = (s: HudSnapshot) => s.mapOpen === true;

/**
 * In-raid HUD. Pointer events are off for the whole layer so aiming/shooting on the canvas is
 * never blocked; only the few buttons opt back in.
 */
export const Hud = memo(function Hud({
  store,
  selfNickname,
  onLeave,
  earnsXp = true,
}: {
  store: HudStore;
  selfNickname: string;
  onLeave: () => void;
  /** Registered players earn XP (guests do not): the compass shows the 8-minute extract XP timer. */
  earnsXp?: boolean;
}) {
  const inPlay = useHud(store, isInPlay);
  // Touch (game/touch-controls.ts mounts sticks + buttons): a compact bottom bar between the two
  // thumb zones, the menu / audio chips top left instead of in the right thumb's corner, USE
  // instead of the F keycap. The transient top stack, the bottom bar and the kill feed are drawn at
  // 80 % / 78 % / 85 % so a landscape phone shows more of the world. hudReservedRects() in
  // touch-controls.ts mirrors this layout.
  const touch = useTouchMode();
  // Touch: the full map (minimap tap) fills a short screen; the bar and the extract pill would cover it.
  const mapOpen = useHud(store, mapOpenSlice) && touch;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const box = useBoxSize(rootRef);

  return (
    // Same safe-area box as the game mount (battle-screen.tsx), so hudReservedRects() in
    // touch-controls.ts, which measures from the mount, still mirrors this layout.
    <div ref={rootRef} className="pointer-events-none absolute inset-y-0 left-[env(safe-area-inset-left,0px)] right-[env(safe-area-inset-right,0px)] select-none text-white">
      {inPlay && <LowHpVignette store={store} />}

      <KillFeed store={store} selfNickname={selfNickname} touch={touch} />

      {/*
        HUD v3: one row along the top edge, nothing over the player in the middle. Left: (touch) the
        menu / audio chips and the ping, then the wipe pill and the XP chip. Right: the extract pill,
        left of the minimap. hudReservedRects() in touch-controls.ts mirrors this.
      */}
      <div className={clsx("absolute flex items-center", touch ? "left-2 top-2 gap-1.5" : "left-3 top-3 gap-2")}>
        {touch && <TouchMenu onLeave={onLeave} />}
        {touch && <PingBadge store={store} touch />}
        <PhaseTimer store={store} touch={touch} />
        {inPlay && earnsXp && <XpTicker store={store} touch={touch} earnsXp={earnsXp} />}
      </div>
      {inPlay && !mapOpen && box && <ExtractPill store={store} touch={touch} box={box} />}

      {/* Transient warnings (wipe threshold, boss event) under the top row, centred. */}
      <div
        className={clsx(
          "absolute left-1/2 flex -translate-x-1/2 flex-col items-center gap-2",
          touch ? "top-12 origin-top scale-[0.8]" : "top-16",
        )}
      >
        {inPlay && <WipeBanner store={store} touch={touch} />}
        <BossToast store={store} touch={touch} />
      </div>

      {inPlay && (
        <div
          className={clsx(
            "absolute left-1/2 flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-col items-center gap-2",
            touch ? "bottom-1 origin-bottom scale-[0.78]" : "bottom-3",
            mapOpen && "hidden",
          )}
        >
          <InteractHint store={store} touch={touch} />
          <ActionProgress store={store} />
          <BottomBar store={store} touch={touch} />
        </div>
      )}

      {!touch && (
        <>
          <PingBadge store={store} touch={false} />
          {/* Volume / mute / sound-ring toggle; sits right above the controls chip. */}
          <div className="absolute bottom-14 right-3 hidden md:block">
            <AudioSettingsButton direction="up" align="right" />
          </div>
          <ControlsHelp onLeave={onLeave} />
        </>
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ top */

/** Width × height of an element (the HUD box), null until measured. */
function useBoxSize(ref: React.RefObject<HTMLElement | null>): { w: number; h: number } | null {
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      setBox((b) => (b && b.w === w && b.h === h ? b : w > 0 && h > 0 ? { w, h } : b));
    };
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/**
 * The wipe pill of the top-left row; the countdown is whole seconds, so this changes about once a
 * second. WORLD v6: "Wipe in m:ss" to the end of the map (urgent in the last 5 minutes). When THIS
 * player's extracts open is the extract pill's business (top right).
 */
function phaseTimerSlice(s: HudSnapshot) {
  const left = s.durationMs - s.clockMs;
  return {
    ended: s.phase === "ended",
    countdown: s.phase === "ended" ? "" : fmtClock(left),
    urgent: s.phase !== "ended" && left <= WIPE_URGENT_MS,
    aliveCount: s.aliveCount,
  };
}

function PhaseTimer({ store, touch }: { store: HudStore; touch: boolean }) {
  const { ended, countdown, urgent, aliveCount } = useHud(store, phaseTimerSlice, shallowEqual);
  return (
    <div
      className={clsx(
        "toon-chip flex shrink-0 items-center whitespace-nowrap tracking-wide",
        touch ? "h-8 gap-1.5 px-2.5 text-xs" : "h-10 gap-2 px-3.5 text-sm",
        urgent && "animate-pulse bg-[#3a1620]/95",
      )}
      title="Time until this map is wiped: extract before it, or lose what you carry"
    >
      <span className="toon-text-thin">
        {ended ? (
          "Map wiped"
        ) : (
          <>
            Wipe in <span className={clsx("tabular-nums", urgent ? "text-rose-400" : "text-zooa-lime")}>{countdown}</span>
          </>
        )}
      </span>
      <span className={clsx("w-[2px] rounded bg-black/60", touch ? "h-4" : "h-5")} aria-hidden />
      <span
        className="flex items-center gap-1"
        title="Raiders on the map right now (NPCs are not counted)"
        aria-label={`On map: ${aliveCount}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/player.png" alt="" className={touch ? "h-5 w-5" : "h-6 w-6"} draggable={false} />
        <span className="toon-text-thin tabular-nums">{aliveCount}</span>
      </span>
    </div>
  );
}

const wipeWarnSlice = (s: HudSnapshot) => s.wipeWarn;

/** "Wipe in 5:00 — head for an extract": shown for a few seconds after each threshold (D2). */
function WipeBanner({ store, touch }: { store: HudStore; touch: boolean }) {
  const warn = useHud(store, wipeWarnSlice);
  if (!warn) return null;
  return (
    <div
      role="alert"
      className={clsx(
        "toon-panel animate-outcome-enter tracking-wide",
        touch ? "px-4 py-1.5 text-sm" : "px-5 py-2 text-base md:text-lg",
        warn <= 60 ? "bg-[#3a1620]/95 text-rose-200" : "bg-[#3a2a10]/95 text-amber-200",
      )}
    >
      <span className="toon-text-thin whitespace-nowrap">{wipeWarnText(warn)}</span>
    </div>
  );
}

/** Boss identity + state; changes only on join and when the boss dies. */
function bossSlice(s: HudSnapshot) {
  return s.boss ? `${s.boss.kind}|${s.boss.state}|${s.boss.zone}` : "";
}

/**
 * Boss event toast (D13), derived from BattleState: on join ("BOSS EVENT · Foreman holds the
 * Grain Elevator") and when the boss state changes ("Foreman is down").
 */
function BossToast({ store, touch }: { store: HudStore; touch: boolean }) {
  const key = useHud(store, bossSlice);
  const [shown, setShown] = useState<{ key: string; title: string; sub: string; down: boolean } | null>(null);
  useEffect(() => {
    const b = store.getSnapshot().boss;
    if (!key || !b) {
      setShown(null);
      return;
    }
    const t = bossToastText(b);
    setShown({ key, title: t.title, sub: t.sub, down: b.state === 2 });
    const id = window.setTimeout(() => setShown((cur) => (cur?.key === key ? null : cur)), BOSS_TOAST_MS);
    return () => window.clearTimeout(id);
  }, [key, store]);
  if (!shown) return null;
  return (
    <div
      role="status"
      className={clsx(
        "toon-panel animate-outcome-enter flex flex-col items-center text-center",
        touch ? "max-w-[21.5rem] px-4 py-1.5" : "px-5 py-2",
        shown.down ? "bg-[#161b28]/95" : "bg-[#2a0d10]/95",
      )}
    >
      <span className={clsx("toon-text-thin tracking-[0.2em]", touch ? "text-base" : "text-lg", shown.down ? "text-zooa-lime" : "text-rose-400")}>
        {shown.title}
      </span>
      {!shown.down && <span className={clsx("font-body font-semibold text-white/85", touch ? "text-xs" : "text-sm")}>{shown.sub}</span>}
    </div>
  );
}

/** The extract pill sits this far left of the minimap (px). */
const EXTRACT_PILL_GAP = 8;

/**
 * HUD v3 extract pill, top edge, left of the minimap: an exit icon, a short status and a value on
 * the right. Closed: "Extract closed" + the countdown to this player's arm. Open: "Extract open"
 * over the nearest extract's name, then an arrow toward it and the distance. Extracting:
 * "Extracting" + the seconds left over a thin progress fill (replaces the big centred ring, so the
 * player and the ground around them stay visible).
 */
function ExtractPill({ store, touch, box }: { store: HudStore; touch: boolean; box: { w: number; h: number } }) {
  const p = useHud(store, extractPillSlice, shallowEqual);
  if (p.kind === "none") return null;
  const mm = minimapSize(box.w, box.h);
  const style = {
    right: MINIMAP_MARGIN + mm + EXTRACT_PILL_GAP,
    // Touch: centred on the menu chips' row (top-2, 40 px); desktop: level with the minimap's top.
    top: touch ? 12 : MINIMAP_MARGIN,
    maxWidth: touch ? EXTRACT_PILL_MAX_W : EXTRACT_PILL_MAX_W_DESKTOP,
  };
  const shell = clsx(
    "toon-chip absolute flex items-center overflow-hidden whitespace-nowrap tracking-wide",
    touch ? "h-8 gap-1.5 pl-1 pr-2.5 text-xs" : "h-10 gap-2 pl-1.5 pr-3.5 text-sm",
  );
  const icon = (tone: "closed" | "open" | "busy") => (
    <span
      className={clsx(
        "relative z-[1] grid shrink-0 place-items-center rounded-full border-2 border-black",
        touch ? "h-6 w-6" : "h-7 w-7",
        tone === "closed" ? "bg-zinc-400" : "bg-zooa-lime",
      )}
      aria-hidden
    >
      {/* Exit: a door frame with an arrow leaving it. */}
      <svg viewBox="0 0 24 24" className={touch ? "h-4 w-4" : "h-5 w-5"}>
        <path d="M10 4H5v16h5M13 8l4 4-4 4M17 12H8" fill="none" stroke="#000" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  if (p.kind === "extracting") {
    return <ExtractingPill store={store} className={shell} style={style} icon={icon("busy")} startedAtMs={p.startedAtMs} channelMs={p.channelMs} touch={touch} />;
  }
  if (p.kind === "closed") {
    return (
      <div className={shell} style={style} role="status" title="Your extraction points open when this countdown ends">
        {icon("closed")}
        <span className="toon-text-thin text-white/80">Extract closed</span>
        <span className="toon-text-thin ml-auto pl-1 tabular-nums text-amber-300">{p.countdown}</span>
      </div>
    );
  }
  // Open: the route to the nearest allowed extract (an extract with its own later opening shows grey).
  return (
    <div
      className={shell}
      style={style}
      role="status"
      title={p.targetOpen ? "Nearest open extraction point: stand in its circle to leave" : "Nearest extraction point (not open yet)"}
    >
      {icon(p.targetOpen ? "open" : "closed")}
      <span className="flex min-w-0 flex-col justify-center gap-[3px] leading-none">
        <span className={clsx("toon-text-thin uppercase", touch ? "text-[0.55rem]" : "text-[0.65rem]", p.targetOpen ? "text-zooa-lime" : "text-white/60")}>
          {p.targetOpen ? "Extract open" : "Extract closed"}
        </span>
        <span className="toon-text-thin truncate">{p.hasTarget ? p.name || "Extract" : "No extract in reach"}</span>
      </span>
      {p.hasTarget && (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-1">
          <svg
            viewBox="0 0 24 24"
            className={clsx("transition-transform duration-100", touch ? "h-4 w-4" : "h-5 w-5", p.targetOpen ? "text-zooa-lime" : "text-white/70")}
            style={{ transform: `rotate(${p.deg}deg)` }}
            aria-label="Direction"
          >
            <path d="M3 12h13M12 6l7 6-7 6" fill="none" stroke="#000" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 12h13M12 6l7 6-7 6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="toon-text-thin tabular-nums">{p.meters} m</span>
        </span>
      )}
    </div>
  );
}

/** Extracting: seconds left and the fill animate on rAF through refs (no React render per frame). */
function ExtractingPill({
  store,
  className,
  style,
  icon,
  startedAtMs,
  channelMs,
  touch,
}: {
  store: HudStore;
  className: string;
  style: React.CSSProperties;
  icon: React.ReactNode;
  startedAtMs: number;
  channelMs: number;
  touch: boolean;
}) {
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const progress = (clockMs: number) => ({
    pct: clamp01((clockMs - startedAtMs) / Math.max(1, channelMs)),
    secsLeft: Math.max(0, (channelMs - (clockMs - startedAtMs)) / 1000),
  });
  useClockFrames(store, (clockMs) => {
    const { pct, secsLeft } = progress(clockMs);
    if (fillRef.current) fillRef.current.style.transform = `scaleX(${pct})`;
    if (textRef.current) textRef.current.textContent = secsLeft.toFixed(1);
  });
  const initial = progress(store.clockNow());
  return (
    <div className={clsx(className, "border-zooa-lime")} style={style} role="status" title="Extracting: stay in the circle, damage restarts it">
      {/* Progress: a faint fill behind the content and a thin bright line along the bottom edge. */}
      <span
        ref={fillRef}
        className="absolute inset-0 origin-left bg-zooa-lime/20"
        style={{ transform: `scaleX(${initial.pct})` }}
        aria-hidden
      >
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-zooa-lime" />
      </span>
      {icon}
      <span className="toon-text-thin relative text-zooa-lime">Extracting</span>
      {!touch && <span className="font-body relative text-xs font-semibold text-white/75">stay in the circle</span>}
      {/* "s" in the body font: Luckiest Guy's s reads as a 5 next to the digits. */}
      <span className="relative ml-auto flex items-baseline gap-px pl-1">
        <span ref={textRef} className="toon-text-thin tabular-nums text-white">
          {initial.secsLeft.toFixed(1)}
        </span>
        <span className="font-body text-[0.7em] font-bold text-white/70">s</span>
      </span>
    </div>
  );
}

/** The "+N XP" bubble pops in, holds and fades over XP_GAIN_SHOW_MS (renderer.ts keeps it that long). */
function xpPopIn(el: HTMLElement | null): void {
  if (!el || typeof el.animate !== "function") return;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.animate(
    still
      ? [{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }]
      : [
          { opacity: 0, transform: "translateY(6px) scale(0.8)" },
          { opacity: 1, transform: "translateY(0) scale(1.12)", offset: 0.12 },
          { transform: "translateY(0) scale(1)", offset: 0.22 },
          { opacity: 1, offset: 0.75 },
          { opacity: 0, transform: "translateY(-4px)" },
        ],
    { duration: 2400, easing: "ease-out", fill: "both" },
  );
}

const XP_LINE_SHORT: Readonly<Record<XpGain["k"], string>> = {
  containers: "Container",
  objectives: "Objective",
  npc: "Marauder",
  guard: "Guard",
  boss: "Boss",
  pvp: "Raider",
};

function xpTickerSlice(s: HudSnapshot) {
  const g = s.xpGains ?? [];
  const last = g[g.length - 1];
  return {
    total: s.self?.raidXp ?? 0,
    lastId: last?.id ?? 0,
    lastXp: last?.xp ?? 0,
    lastK: last?.k ?? "containers",
    lastN: last?.n ?? 0,
    xpLeftS: extractXpLeftS(s.enteredAtMs, s.clockMs),
  };
}

/**
 * HUD v3 XP chip in the top-left row: the running estimate of this raid (SelfState.raidXp) and,
 * until an extract earns XP (XP.MIN_ONMAP_MS on the map), a small clock with the time left. The
 * latest gain pops as a "+N XP · Marauder" bubble under the chip (EventsMsg.xp), so the row never
 * grows; a container past the per-entry cap shows "Container XP cap reached" instead. The settled
 * XP (daily cap, extract and haul lines) comes on the outcome screen.
 */
function XpTicker({ store, touch, earnsXp }: { store: HudStore; touch: boolean; earnsXp: boolean }) {
  const { total, lastId, lastXp, lastK, lastN, xpLeftS } = useHud(store, xpTickerSlice, shallowEqual);
  const xpLeft = earnsXp ? xpLeftS : 0;
  if (total === 0 && lastId === 0 && xpLeft <= 0) return null;
  const capped = lastId > 0 && lastXp === 0 && lastK === "containers";
  return (
    <div className="relative shrink-0">
      <div
        className={clsx(
          "toon-chip flex items-center whitespace-nowrap tracking-wide",
          touch ? "h-8 gap-1 pl-1 pr-2 text-xs" : "h-10 gap-1.5 pl-1.5 pr-3 text-sm",
        )}
        title="XP earned this raid so far (estimate: the daily limit and the extract XP are settled when you leave)"
      >
        <span
          className={clsx(
            "grid place-items-center rounded-full border-2 border-black bg-amber-300 text-black",
            touch ? "h-6 w-6 text-[0.55rem]" : "h-7 w-7 text-[0.6rem]",
          )}
        >
          XP
        </span>
        <span className="toon-text-thin tabular-nums text-white">{total}</span>
        {xpLeft > 0 && (
          <span
            className="flex items-center gap-0.5 pl-0.5 text-amber-300"
            title={`An extract earns XP after ${Math.round(XP.MIN_ONMAP_MS / 60_000)} minutes on the map`}
            aria-label={`Extract XP in ${fmtClock(xpLeft * 1000)}`}
          >
            <svg viewBox="0 0 16 16" className={touch ? "h-3 w-3" : "h-3.5 w-3.5"} aria-hidden>
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="toon-text-thin tabular-nums">{fmtClock(xpLeft * 1000)}</span>
          </span>
        )}
      </div>
      {lastId > 0 && (
        <span
          key={lastId}
          ref={xpPopIn}
          className={clsx(
            "toon-text-thin absolute left-1 top-full mt-1 whitespace-nowrap",
            touch ? "text-xs" : "text-sm",
            capped ? "text-white/60" : "text-amber-300",
          )}
        >
          {capped ? `Container XP cap reached (${XP.CONTAINER_MAX})` : `+${lastXp} XP · ${XP_LINE_SHORT[lastK]}${lastK === "containers" ? ` ${lastN}/${XP.CONTAINER_MAX}` : ""}`}
        </span>
      )}
    </div>
  );
}

/** Kill feed lines still fresh at this snapshot's clock, newest first. */
function killFeedSlice(s: HudSnapshot): KillFeedEntry[] {
  return s.killFeed
    .filter((e) => s.clockMs - e.atMs < KILL_FEED_TTL_MS)
    .slice(-KILL_FEED_MAX)
    .reverse();
}

/** Entries never change once created, so the same ids in the same order mean the same list. */
function sameEntries(a: KillFeedEntry[], b: KillFeedEntry[]) {
  return a.length === b.length && a.every((e, i) => e.id === b[i]!.id);
}

function KillFeed({ store, selfNickname, touch }: { store: HudStore; selfNickname: string; touch: boolean }) {
  const fresh = useHud(store, killFeedSlice, sameEntries);
  if (fresh.length === 0) return null;
  return (
    // Touch: below the menu / audio chips of the top-left corner.
    <ol
      className={clsx(
        "absolute left-3 flex max-w-[min(22rem,40vw)] flex-col gap-1.5",
        touch ? "left-2 top-[3.25rem] origin-top-left scale-[0.85]" : "top-16",
      )}
      aria-label="Kill feed"
    >
      {fresh.map((e) => {
        // NPC MODEL v5: NPC names come by role ("Marauder ✕ Vlad", personal "You ✕ Marauder").
        const n = killFeedNames(e, selfNickname);
        return (
          <li
            key={e.id}
            className={clsx(
              "toon-chip flex items-center gap-2 px-3 py-1 text-sm tracking-wide animate-outcome-enter",
              n.personal && "opacity-90",
            )}
          >
            {n.killer ? (
              <>
                <Name who={n.killer} self={n.personal || (!n.killer.npc && e.killer === selfNickname)} />
                {e.weapon && isKillWeapon(e.weapon) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={killWeaponIcon(e.weapon)}
                    alt={killWeaponName(e.weapon)}
                    title={killWeaponName(e.weapon)}
                    className={clsx("object-contain", e.weapon === "grenade" ? "h-6 w-6" : "h-6 w-10")}
                    draggable={false}
                  />
                ) : (
                  <span className="text-white/60">killed</span>
                )}
                <Name who={n.victim} self={!n.victim.npc && e.victim === selfNickname} victim />
              </>
            ) : (
              <>
                <Name who={n.victim} self={!n.victim.npc && e.victim === selfNickname} victim />
                <span className="text-white/60">died</span>
              </>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function Name({ who, self, victim }: { who: FeedName; self: boolean; victim?: boolean }) {
  if (who.npc) {
    return (
      <span className="flex min-w-0 items-center gap-1" title={npcLabels().npc}>
        <NpcBadge role={who.npc} />
        <span
          className={clsx("toon-text-thin max-w-[9rem] truncate", who.npc === "boss" && "tracking-wider")}
          style={{ color: cssHex(NPC_TAG_COLOR[who.npc]) }}
        >
          {who.name}
        </span>
      </span>
    );
  }
  return (
    <span
      className={clsx(
        "toon-text-thin max-w-[9rem] truncate",
        self ? "text-amber-300" : victim ? "text-rose-300" : "text-white",
      )}
    >
      {who.name}
    </span>
  );
}

/** Small role badge before an NPC name: skull for a boss, shield for a guard, chevron for a marauder. */
function NpcBadge({ role }: { role: NonNullable<FeedName["npc"]> }) {
  const fill = cssHex(NPC_TAG_COLOR[role]);
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" aria-hidden>
      {role === "boss" ? (
        <>
          <circle cx="8" cy="7" r="5.5" fill={fill} stroke="#000" strokeWidth="1.2" />
          <circle cx="6" cy="7" r="1.4" fill="#16090a" />
          <circle cx="10" cy="7" r="1.4" fill="#16090a" />
          <rect x="5.5" y="11" width="5" height="3" rx="0.8" fill={fill} stroke="#000" strokeWidth="1" />
        </>
      ) : role === "guard" ? (
        <path d="M2 2h12v7l-6 6-6-6z" fill={fill} stroke="#000" strokeWidth="1.3" />
      ) : (
        <>
          <rect x="1.5" y="2" width="13" height="12" rx="3" fill={fill} stroke="#000" strokeWidth="1.3" />
          <path d="M4.5 5l3.5 2.5L11.5 5v2L8 9.5 4.5 7zM4.5 8.5l3.5 2.5 3.5-2.5v2L8 13l-3.5-2.5z" fill="#23210f" />
        </>
      )}
    </svg>
  );
}

/* --------------------------------------------------------------- center */

const hintSlice = (s: HudSnapshot) => s.interactHint;

function InteractHint({ store, touch }: { store: HudStore; touch: boolean }) {
  const hint = useHud(store, hintSlice);
  if (!hint) return null;
  // Renderer formats hints as "F — <action>"; show the key as a keycap (the hand button's icon on touch).
  // A status line without an action ("Locked — needs …", "Cracking…") gets no key.
  const m = /^F\s*[—–-]\s*(.+)$/.exec(hint);
  // A ground item that does not fit (hud.ts BAG_FULL_HINT): say so, and how to make room.
  if (hint.startsWith(BAG_FULL_HINT)) {
    return (
      <div className="toon-chip flex items-center gap-2 border-rose-500 px-3 py-1.5 text-sm tracking-wide md:text-base" role="status">
        <span className="toon-text-thin text-rose-300">Bag full</span>
        <span className="font-body text-xs font-semibold text-white/80 md:text-sm">no room for {hint.slice(BAG_FULL_HINT.length)}</span>
        <span className="h-4 w-px bg-white/25" aria-hidden />
        {touch ? <span className="toon-key px-1.5">Bag</span> : <span className="toon-key">Tab</span>}
        <span className="font-body text-xs font-semibold text-white/80 md:text-sm">drop something</span>
      </div>
    );
  }
  return (
    <div className="toon-chip flex items-center gap-2 px-3 py-1.5 text-sm tracking-wide md:text-base">
      {m &&
        (touch ? (
          <span
            className="toon-key grid h-6 w-7 place-items-center px-0.5 text-white"
            aria-label="Use button"
            dangerouslySetInnerHTML={{ __html: touchIconSvg("use", 90) }}
          />
        ) : (
          <span className="toon-key">F</span>
        ))}
      <span className="toon-text-thin">{m ? m[1] : hint}</span>
    </div>
  );
}

/** The running reload or heal (reload wins, as before), or null. Changes only when one starts or ends. */
function actionSlice(s: HudSnapshot) {
  const self = s.self;
  if (!self) return null;
  if (self.reloading) return { label: "Reloading", start: self.reloading.startMs, until: self.reloading.untilMs, color: "#ffc21a" };
  if (self.healing) {
    return {
      label: self.healing.kind === "medkit" ? "Using medkit" : "Bandaging",
      start: self.healing.startMs,
      until: self.healing.untilMs,
      color: "#4ade80",
    };
  }
  // Open delay of a search; the search panel takes over once the container is open.
  if (self.search && s.clockMs < self.search.readyAtMs) {
    return { label: "Opening", start: self.search.startMs, until: self.search.readyAtMs, color: "#60a5fa" };
  }
  return null;
}

function ActionProgress({ store }: { store: HudStore }) {
  const action = useHud(store, actionSlice, shallowEqual);
  if (!action) return null;
  return <ActionProgressView store={store} {...action} />;
}

/** The bar and seconds animate on rAF through refs. */
function ActionProgressView({
  store,
  label,
  start,
  until,
  color,
}: {
  store: HudStore;
  label: string;
  start: number;
  until: number;
  color: string;
}) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const progress = (clockMs: number) => ({
    pct: clamp01((clockMs - start) / Math.max(1, until - start)),
    left: Math.max(0, (until - clockMs) / 1000),
  });
  useClockFrames(store, (clockMs) => {
    const { pct, left } = progress(clockMs);
    if (barRef.current) barRef.current.style.width = `${pct * 100}%`;
    if (textRef.current) textRef.current.textContent = `${left.toFixed(1)}s`;
  });
  const initial = progress(store.clockNow());
  return (
    <div className="toon-panel flex w-64 items-center gap-2 px-2.5 py-1.5">
      <span className="toon-text-thin w-24 shrink-0 text-xs tracking-wide">{label}</span>
      <div className="relative h-3.5 flex-1 overflow-hidden rounded-full border-2 border-black bg-black/60">
        <div
          ref={barRef}
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${initial.pct * 100}%`, background: color }}
        />
      </div>
      <span ref={textRef} className="w-9 shrink-0 text-right text-xs tabular-nums text-white/80">
        {initial.left.toFixed(1)}s
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- bottom */

/**
 * Everything the bottom bar shows. Timers are left out (they belong to ActionProgress /
 * ExtractRing), so a reload ticking does not re-render the weapon cards.
 */
function bottomBarSlice(s: HudSnapshot): HudSelf | null {
  if (!s.self) return null;
  // Roll / walk / search have their own leaves; leaving them out keeps the weapon cards still.
  return {
    ...s.self,
    reloading: null,
    healing: null,
    extracting: null,
    search: null,
    walking: false,
    roll: NO_ROLL,
  };
}

const NO_ROLL: HudSelf["roll"] = { readyAtMs: 0, cdStartMs: 0, rolling: false };

function BottomBar({ store, touch }: { store: HudStore; touch: boolean }) {
  const self = useHud(store, bottomBarSlice, deepEqual);
  if (!self) return null;
  if (touch) {
    // Touch: ~28 rem wide and 5.75 rem tall so it fits between the thumb zones. Roll and quiet walk
    // are the ROLL button and a part-deflected move stick; bandage / medkit counts are on their
    // buttons, so only the carry line of the meds panel stays.
    return (
      <div className="flex items-end gap-2">
        <VitalsPanel self={self} compact />
        <WeaponSlotCard slot={self.slots[0]} index={0} active={self.active === 0} reserve={reserveFor(self, self.slots[0])} compact />
        <WeaponSlotCard slot={self.slots[1]} index={1} active={self.active === 1} reserve={reserveFor(self, self.slots[1])} compact />
        <CarryPanel self={self} />
      </div>
    );
  }
  return (
    <div className="flex items-end gap-2 md:gap-3">
      <MovePanel store={store} />
      <VitalsPanel self={self} />
      <WeaponSlotCard slot={self.slots[0]} index={0} active={self.active === 0} reserve={reserveFor(self, self.slots[0])} />
      <WeaponSlotCard slot={self.slots[1]} index={1} active={self.active === 1} reserve={reserveFor(self, self.slots[1])} />
      <MedsPanel self={self} />
    </div>
  );
}

/* ------------------------------------------------------------- movement */

const PIE_R = 15;
const PIE_C = 2 * Math.PI * PIE_R;

/** Roll cooldown + quiet walk: changes only when a roll starts / ends or Shift toggles. */
function moveSlice(s: HudSnapshot) {
  const self = s.self;
  if (!self) return null;
  return { readyAtMs: self.roll.readyAtMs, cdStartMs: self.roll.cdStartMs, walking: self.walking };
}

/**
 * Space (dodge roll) cooldown pie and the Shift quiet-walk indicator. The pie animates on rAF
 * through refs from the store's extrapolated clock, so a 5 s cooldown costs no React renders.
 */
function MovePanel({ store }: { store: HudStore }) {
  const m = useHud(store, moveSlice, shallowEqual);
  const arcRef = useRef<SVGCircleElement | null>(null);
  const keyRef = useRef<HTMLSpanElement | null>(null);
  const readyAt = m?.readyAtMs ?? 0;
  const start = m?.cdStartMs ?? 0;
  const progress = (clockMs: number) => (readyAt <= 0 ? 1 : clamp01((clockMs - start) / Math.max(1, readyAt - start)));
  useClockFrames(store, (clockMs) => {
    const p = progress(clockMs);
    arcRef.current?.setAttribute("stroke-dashoffset", String(PIE_C * (1 - p)));
    if (keyRef.current) keyRef.current.style.opacity = p >= 1 ? "1" : "0.45";
  });
  if (!m) return null;
  const p0 = progress(store.clockNow());
  return (
    <div className="toon-panel flex flex-col items-center gap-1.5 p-2" aria-label="Movement">
      <div className="relative h-10 w-10" title="Space — dodge roll (5 s cooldown)">
        <svg viewBox="0 0 40 40" className="h-full w-full -rotate-90" aria-hidden>
          <circle cx="20" cy="20" r={PIE_R + 3} fill="rgba(0,0,0,0.6)" stroke="#000" strokeWidth="2" />
          <circle
            ref={arcRef}
            cx="20"
            cy="20"
            r={PIE_R}
            fill="none"
            stroke="#CCFF00"
            strokeWidth="6"
            strokeDasharray={PIE_C}
            strokeDashoffset={PIE_C * (1 - p0)}
          />
        </svg>
        <span ref={keyRef} className="toon-text-thin absolute inset-0 grid place-items-center text-[0.6rem] tracking-wide" style={{ opacity: p0 >= 1 ? 1 : 0.45 }}>
          ROLL
        </span>
      </div>
      <span
        className={clsx(
          "flex items-center gap-1 rounded-full border-2 border-black px-1.5 py-0.5 text-[0.6rem] tracking-wide transition-colors",
          m.walking ? "bg-sky-300 text-black" : "bg-black/50 text-white/45",
        )}
        title="Shift — quiet walk (half speed, short footstep range)"
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
          <path d="M5 2c1.2 0 2 1.3 2 3s-.8 3-2 3-2-1.3-2-3 .8-3 2-3zm6 5c1.2 0 2 1.3 2 3s-.8 3-2 3-2-1.3-2-3 .8-3 2-3zM4 10h2v3H4zm6 4h2v1h-2z" fill="currentColor" />
        </svg>
        QUIET
      </span>
    </div>
  );
}

function reserveFor(self: HudSelf, slot: HudSlot): number {
  if (!slot.weapon) return 0;
  return self.ammo[WEAPONS[slot.weapon].ammo];
}

function VitalsPanel({ self, compact = false }: { self: HudSelf; compact?: boolean }) {
  const hpPct = clamp01(self.hp / Math.max(1, self.maxHp));
  const hpColor = hpPct > 0.6 ? "#4ade80" : hpPct > 0.3 ? "#facc15" : "#f43f5e";
  const armorPct = self.armor > 0 ? clamp01(self.armorDur / Math.max(1, self.armorMax)) : 0;
  return (
    <div className={clsx("toon-panel flex flex-col", compact ? "w-[12.5rem] gap-1.5 p-2" : "w-[15.5rem] gap-2 p-2.5 md:w-[17rem]")}>
      <div className="flex items-center gap-2">
        <span className={clsx("toon-text-thin text-sm text-rose-300", compact ? "w-7" : "w-9")}>HP</span>
        <Bar pct={hpPct} color={hpColor} height={compact ? "h-5" : "h-6"} />
        <span className="toon-text-thin w-10 text-right text-lg tabular-nums">{Math.ceil(self.hp)}</span>
      </div>
      <div className={clsx("flex items-center gap-2", self.armor === 0 && "opacity-50")}>
        <span className={clsx("relative grid shrink-0 place-items-center", compact ? "h-7 w-7" : "h-9 w-9")}>
          {self.armor > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={armorIcon(self.armor)} alt="" className={clsx("object-contain", compact ? "h-7 w-7" : "h-9 w-9")} draggable={false} />
          ) : (
            <span className={clsx("rounded-lg border-2 border-dashed border-white/40", compact ? "h-6 w-6" : "h-7 w-7")} />
          )}
          {self.armor > 0 && (
            <span className="toon-key absolute -bottom-1 -right-1 h-4 min-w-4 bg-sky-300 px-0.5 text-[0.6rem]">
              {self.armor}
            </span>
          )}
        </span>
        {self.armor > 0 ? (
          <>
            <Bar pct={armorPct} color="#60a5fa" height="h-4" />
            <span className="w-10 text-right text-sm tabular-nums text-sky-200">{Math.ceil(self.armorDur)}</span>
          </>
        ) : (
          <span className="text-xs tracking-wide text-white/70">No armor</span>
        )}
      </div>
    </div>
  );
}

function Bar({ pct, color, height }: { pct: number; color: string; height: string }) {
  return (
    <div className={clsx("relative flex-1 overflow-hidden rounded-full border-[3px] border-black bg-black/60", height)}>
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-150"
        style={{ width: `${pct * 100}%`, background: color, boxShadow: "inset 0 -4px 0 rgba(0,0,0,0.25), inset 0 3px 0 rgba(255,255,255,0.35)" }}
      />
    </div>
  );
}

function WeaponSlotCard({
  slot,
  index,
  active,
  reserve,
  compact = false,
}: {
  slot: HudSlot;
  index: 0 | 1;
  active: boolean;
  reserve: number;
  /** Touch HUD: 5.25 × 5.5 rem instead of 6.5 × 6–7 rem. */
  compact?: boolean;
}) {
  const weapon = slot.weapon as WeaponId | "";
  const box = compact ? "h-[5.25rem] w-[5.5rem]" : "h-[6.5rem] w-24 md:w-28";
  if (!weapon) {
    return (
      <div className={clsx("relative grid place-items-center rounded-2xl border-[3px] border-dashed border-black/80 bg-[#1d2333]/60", box)}>
        {!compact && <span className="toon-key absolute left-1.5 top-1.5">{index + 1}</span>}
        <span className="text-xs tracking-wide text-white/50">Empty</span>
      </div>
    );
  }
  const color = rarityHex(slot.rarity);
  const def = WEAPONS[weapon];
  return (
    <div
      className={clsx(
        "relative flex flex-col items-center justify-between rounded-2xl border-[3px] border-black px-1.5 pb-1.5 pt-1 shadow-[0_4px_0_#000] transition-transform duration-150",
        box,
        active ? (compact ? "-translate-y-1.5" : "-translate-y-2") : "opacity-80",
      )}
      style={{
        background: `linear-gradient(180deg, ${color}66 0%, #1d2333f0 70%)`,
        // Inline because Tailwind rings are box-shadows too and would be overwritten by the glow.
        boxShadow: active ? `0 0 0 3px #CCFF00, 0 6px 0 #000, 0 0 24px ${color}aa` : undefined,
      }}
      title={`${def.name} — ${rarityName(slot.rarity)}${slot.free ? " (basic gear)" : ""}`}
    >
      {!compact && <span className="toon-key absolute left-1.5 top-1.5">{index + 1}</span>}
      <span
        className="toon-text-thin absolute right-1.5 top-1.5 text-[0.6rem] uppercase tracking-wider"
        style={{ color: slot.broken ? "#f87171" : slot.free ? "#d4d4d8" : color }}
      >
        {slot.broken ? "Broken" : slot.free ? "Free" : rarityName(slot.rarity)}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={weaponIcon(weapon)}
        alt={def.name}
        className={clsx("object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.6)]", compact ? "mt-4 h-8 w-16" : "mt-5 h-11 w-20")}
        draggable={false}
      />
      <div className="flex items-baseline gap-1 tabular-nums">
        <span className={clsx("toon-text-thin", compact ? "text-lg leading-6" : "text-xl", slot.mag === 0 ? "text-rose-400" : "text-white")}>{slot.mag}</span>
        <span className="text-xs text-white/70">/ {reserve}</span>
      </div>
    </div>
  );
}

/**
 * v2 carry rule for a med (no per-item cap any more): it stacks `stack` per slot, so what still fits
 * is the room left in its own stacks plus `stack` for every free pocket / backpack slot.
 */
export function medTooltip(kind: "bandage" | "medkit", count: number, freeSlots: number): string {
  const heal = HEAL[kind];
  const stack = Math.max(1, itemDef(kind)?.stack ?? 1);
  const inStacks = Math.ceil(Math.max(0, count) / stack) * stack - Math.max(0, count);
  const room = inStacks + Math.max(0, freeSlots) * stack;
  const name = kind === "bandage" ? "Bandage" : "Medkit";
  return `${name}: +${heal.HP} HP after a ${heal.MS / 1000} s channel · ${stack} per slot · room for ${room} more`;
}

/** Weapons v2: what a hand grenade does, from the shared GRENADE numbers. */
export function grenadeTooltip(): string {
  const m = (px: number) => Math.round(px / PX_PER_METER);
  return (
    `Hand grenade: throw with G or 5 toward the cursor (${m(GRENADE.MIN_PX)}–${m(GRENADE.MAX_PX)} m). ` +
    `Goes off ${GRENADE.FUSE_MS / 1000} s after the throw: ${GRENADE.DAMAGE} damage close up, ` +
    `down to ${GRENADE.EDGE_DAMAGE} at ${m(GRENADE.EDGE_PX)} m. Walls stop the blast; it hurts you too.`
  );
}

function MedsPanel({ self }: { self: HudSelf }) {
  const free = self.storageCap - self.storageUsed;
  return (
    <div className="toon-panel flex flex-col gap-1.5 p-2">
      <MedRow icon="/sprites/bandage.png" count={self.bandages} keyHint="3" title={medTooltip("bandage", self.bandages, free)} />
      <MedRow icon="/sprites/medkit.png" count={self.medkits} keyHint="4" title={medTooltip("medkit", self.medkits, free)} />
      {self.grenades > 0 && <MedRow icon="/sprites/grenade.png" count={self.grenades} keyHint="G" title={grenadeTooltip()} />}
      <div
        className="flex items-center justify-between gap-2 border-t-2 border-black/50 pt-1 text-[0.65rem] tabular-nums text-white/75"
        title="Inventory (Tab or I): storage slots used (pockets + backpack) and the junk value you carry if you extract"
      >
        <span className="flex items-center gap-1">
          <span className="toon-key h-5 min-w-5 px-1 text-[0.6rem]">Tab</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/sprites/backpack.png" alt="" className="h-4 w-4 object-contain" draggable={false} />
          <span className={clsx(self.storageUsed >= self.storageCap && "text-rose-300")}>
            {self.storageUsed}/{self.storageCap}
          </span>
        </span>
        {self.creditsEstimate > 0 && <span className="text-amber-300">≈{fmtCr(self.creditsEstimate)}</span>}
      </div>
    </div>
  );
}

/** Touch HUD: the meds panel's carry line only (the counts are on the bandage / medkit buttons). */
function CarryPanel({ self }: { self: HudSelf }) {
  return (
    <div
      className="toon-panel flex h-[5.25rem] flex-col items-center justify-center gap-1 px-2 text-xs tabular-nums text-white/80"
      aria-label={`Storage ${self.storageUsed} of ${self.storageCap}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/sprites/backpack.png" alt="" className="h-6 w-6 object-contain" draggable={false} />
      <span>
        {self.storageUsed}/{self.storageCap}
      </span>
      {self.creditsEstimate > 0 && <span className="text-[0.65rem] text-amber-300">≈{fmtCr(self.creditsEstimate)}</span>}
    </div>
  );
}

function MedRow({ icon, count, keyHint, title }: { icon: string; count: number; keyHint: string; title: string }) {
  return (
    <div className={clsx("flex items-center gap-1.5", count === 0 && "opacity-45")} title={title}>
      <span className="toon-key">{keyHint}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" className="h-8 w-8 object-contain" draggable={false} />
      <span className="toon-text-thin w-6 text-lg tabular-nums">{count}</span>
    </div>
  );
}

/* -------------------------------------------------------------- corners */

const pingSlice = (s: HudSnapshot) => s.pingMs;

function PingBadge({ store, touch }: { store: HudStore; touch: boolean }) {
  const pingMs = useHud(store, pingSlice);
  const tone =
    pingMs == null ? "bg-zinc-500" : pingMs < 100 ? "bg-emerald-400" : pingMs < 200 ? "bg-amber-400" : "bg-rose-500";
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 text-[0.65rem] tabular-nums text-white/75",
        // Touch: next to the menu / audio chips (the bottom-left corner is the move stick's).
        touch ? "bg-black/40 px-1.5 py-0.5" : "absolute bottom-3 left-3",
      )}
      title="Round-trip time to the game server"
    >
      <span className={clsx("h-2 w-2 rounded-full", tone)} aria-hidden />
      {pingMs == null ? "— ms" : `${pingMs} ms`}
    </div>
  );
}

const CONTROLS: Array<[string, string]> = [
  ["WASD", "Move"],
  ["Mouse", "Aim"],
  ["LMB", "Shoot"],
  ["R", "Reload"],
  ["F", "Search / pick up"],
  ["Space", "Dodge roll"],
  ["Shift", "Quiet walk"],
  ["Tab / I", "Inventory · drop items"],
  ["T", "Take all"],
  ["M", "Map"],
  ["1 / 2", "Switch weapon"],
  ["3", "Bandage"],
  ["4", "Medkit"],
  ["G / 5", "Throw grenade (at the cursor)"],
];

/**
 * Controls cheat-sheet + "Leave raid". Collapsed to a small chip by default (the choice is
 * remembered), hidden below 768 px where the bottom bar needs the whole width.
 *
 * Layout contract with the bottom HUD (BottomBar is ~40 rem wide and ~7.5 rem tall at md+):
 * - the chip sits in the bottom-right corner and is narrow enough ("?" below lg, "? Controls"
 *   at lg+) to fit beside the centered bar from 768 px / 1024 px up;
 * - the open panel floats above the bar's height (bottom-36), so it never covers the meds or the
 *   weapon slots however narrow the window is.
 */
function ControlsHelp({ onLeave }: { onLeave: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(HELP_STORAGE_KEY) === "1") setOpen(true);
    } catch {
      /* storage blocked: keep default */
    }
  }, []);

  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(HELP_STORAGE_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
    setConfirmLeave(false);
  };

  return (
    <div className="pointer-events-none absolute inset-0 hidden md:block">
      {open && (
        <div
          id="hud-controls-panel"
          className="toon-panel pointer-events-auto absolute bottom-36 right-3 w-60 p-3"
        >
          <ul className="space-y-1.5">
            {CONTROLS.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="font-body text-sm font-semibold text-white/85">{v}</span>
                <span className="toon-key">{k}</span>
              </li>
            ))}
          </ul>
          <p className="font-body mt-3 border-t-2 border-black/50 pt-2 text-xs leading-snug text-white/65">
            Dying breaks each item with a {Math.round(BREAK_CHANCE_ON_DEATH * 100)}% chance; the rest drops for others.
          </p>
          <button
            type="button"
            onClick={() => (confirmLeave ? onLeave() : setConfirmLeave(true))}
            className={clsx(
              "mt-3 w-full rounded-xl border-2 border-black py-1.5 text-xs tracking-wide shadow-[0_3px_0_#000] transition active:translate-y-[2px] active:shadow-[0_1px_0_#000]",
              confirmLeave ? "bg-rose-500 text-white" : "bg-white/90 text-black",
            )}
          >
            {confirmLeave ? "Sure? Unextracted loot is at risk" : "Leave raid"}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="hud-controls-panel"
        aria-label={open ? "Hide controls" : "Show controls"}
        title={open ? "Hide controls" : "Controls & leave raid"}
        className="toon-chip pointer-events-auto absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center gap-1.5 text-sm tracking-wide text-white transition hover:brightness-125 lg:w-auto lg:px-3"
      >
        <span className="optical-center">{open ? "×" : "?"}</span>
        {/* Wrapper: .optical-center sets display and would override `hidden`. */}
        <span className="hidden text-xs lg:inline">
          <span className="optical-center">{open ? "Hide" : "Controls"}</span>
        </span>
      </button>
    </div>
  );
}

const TOUCH_CONTROLS: Array<[string, string]> = [
  ["Left stick", "Move · push less to walk quietly"],
  ["Right stick", "Aim · fires by itself while the aim is on an enemy (red reticle)"],
  ["Roll · hand", "Dodge roll · search / pick up"],
  ["Reload · swap", "Reload · switch weapon"],
  ["Grenade", "Tap: throw ahead · drag: aim and range"],
  ["Row under the minimap", "Bandage · medkit · bag"],
  ["Minimap", "Tap: full map · tap again to close"],
  ["Extract", "Pill by the minimap: when it opens, the way · stand in the circle"],
];

/**
 * Touch HUD menu, top-left (the bottom corners belong to the sticks): a 40 px menu button with the
 * touch legend and "Leave raid" (two taps), and the audio settings next to it. Shown at every
 * width, so phones narrower than 768 px can leave a raid too.
 */
function TouchMenu({ onLeave }: { onLeave: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <div className="pointer-events-none flex shrink-0 items-start gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            setConfirmLeave(false);
          }}
          aria-expanded={open}
          aria-controls="hud-touch-menu"
          aria-label={open ? "Close menu" : "Menu: controls and leave raid"}
          className="toon-chip pointer-events-auto grid h-10 w-10 place-items-center text-white active:translate-y-[2px]"
        >
          {open ? (
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
              <path d="M5 5l10 10M15 5 5 15" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden>
              <path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
            </svg>
          )}
        </button>
        {open && (
          <div
            id="hud-touch-menu"
            className="toon-panel scroll-fade pointer-events-auto absolute left-0 top-12 z-10 max-h-[calc(100dvh-5rem)] w-72 overflow-y-auto overscroll-contain p-3 short:w-[min(34rem,calc(100vw-6rem))]"
          >
            {/* Landscape phones: two columns, so the list fits without scrolling. */}
            <ul className="space-y-1.5 short:grid short:grid-cols-2 short:gap-x-5 short:gap-y-1.5 short:space-y-0">
              {TOUCH_CONTROLS.map(([k, v]) => (
                <li key={k} className="flex items-baseline justify-between gap-3">
                  <span className="toon-text-thin shrink-0 text-xs tracking-wide text-zooa-lime">{k}</span>
                  <span className="font-body text-right text-xs font-semibold text-white/85">{v}</span>
                </li>
              ))}
            </ul>
            <p className="font-body mt-3 border-t-2 border-black/50 pt-2 text-xs leading-snug text-white/65">
              Dying breaks each item with a {Math.round(BREAK_CHANCE_ON_DEATH * 100)}% chance; the rest drops for others.
            </p>
            <button
              type="button"
              onClick={() => (confirmLeave ? onLeave() : setConfirmLeave(true))}
              className={clsx(
                "mt-3 min-h-11 w-full rounded-xl border-2 border-black text-sm tracking-wide shadow-[0_3px_0_#000] active:translate-y-[2px] active:shadow-[0_1px_0_#000]",
                confirmLeave ? "bg-rose-500 text-white" : "bg-white/90 text-black",
              )}
            >
              {confirmLeave ? "Sure? Unextracted loot is at risk" : "Leave raid"}
            </button>
          </div>
        )}
      </div>
      <AudioSettingsButton direction="down" align="left" />
    </div>
  );
}

/** Vignette strength from HP; 0 above 35% HP, so full-health frames select a constant. */
function lowHpSlice(s: HudSnapshot) {
  const self = s.self;
  if (!self) return 0;
  return 1 - clamp01(self.hp / Math.max(1, self.maxHp) / 0.35);
}

function LowHpVignette({ store }: { store: HudStore }) {
  const t = useHud(store, lowHpSlice);
  if (t <= 0) return null;
  return (
    <div
      className="absolute inset-0"
      style={{ boxShadow: `inset 0 0 ${80 + 80 * t}px rgba(220, 20, 40, ${0.25 + 0.35 * t})` }}
      aria-hidden
    />
  );
}

function clamp01(v: number) {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
