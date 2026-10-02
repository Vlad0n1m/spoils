"use client";

import { memo, useEffect, useState } from "react";
import clsx from "clsx";
import { BREAK_CHANCE_ON_DEATH, HEAL, WEAPONS, type WeaponId } from "@extract/shared";
import type { HudSelf, HudSlot, HudSnapshot, KillFeedEntry } from "@/game/types";
import { fmtClock, isWeaponId, rarityHex, rarityName, armorIcon, weaponIcon } from "@/lib/items-ui";

/** Kill feed lines stay this long (match clock). */
const KILL_FEED_TTL_MS = 7_000;
const KILL_FEED_MAX = 5;
/** Timer turns red in the last minute of the raid. */
const FINAL_MINUTE_MS = 60_000;
/** Rough px → meters for the compass; only has to feel consistent. */
const PX_PER_METER = 40;
const HELP_STORAGE_KEY = "extract:hud-help-open";

/**
 * In-raid HUD. Pointer events are off for the whole layer so aiming/shooting on the canvas is
 * never blocked; only the few buttons opt back in.
 */
export const Hud = memo(function Hud({
  snapshot,
  selfNickname,
  onLeave,
}: {
  snapshot: HudSnapshot;
  selfNickname: string;
  onLeave: () => void;
}) {
  const me = snapshot.self;
  const inPlay = Boolean(me && me.alive && me.extractedAt === 0);

  return (
    <div className="pointer-events-none absolute inset-0 select-none text-white">
      {inPlay && me && <LowHpVignette hp={me.hp} maxHp={me.maxHp} />}

      <KillFeed entries={snapshot.killFeed} clockMs={snapshot.clockMs} selfNickname={selfNickname} />

      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center gap-2">
        <PhaseTimer snapshot={snapshot} />
        {inPlay && snapshot.nearestExtract && <ExtractCompass target={snapshot.nearestExtract} />}
      </div>

      {inPlay && me && (
        <>
          {me.extracting && (
            <ExtractRing
              clockMs={snapshot.clockMs}
              startedAtMs={me.extracting.startedAtMs}
              channelMs={me.extracting.channelMs}
            />
          )}
          <div className="absolute bottom-3 left-1/2 flex w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2 flex-col items-center gap-2">
            {snapshot.interactHint && <InteractHint hint={snapshot.interactHint} />}
            <ActionProgress self={me} clockMs={snapshot.clockMs} />
            <BottomBar self={me} />
          </div>
        </>
      )}

      <PingBadge pingMs={snapshot.pingMs} />
      <ControlsHelp onLeave={onLeave} />
    </div>
  );
});

/* ------------------------------------------------------------------ top */

function PhaseTimer({ snapshot }: { snapshot: HudSnapshot }) {
  const { phase, clockMs, durationMs, extractOpenAtMs } = snapshot;
  const left = durationMs - clockMs;
  const urgent = phase === "open" && left <= FINAL_MINUTE_MS;

  let label: React.ReactNode;
  if (phase === "drop") {
    label = (
      <>
        Extraction opens in <span className="tabular-nums text-amber-300">{fmtClock(extractOpenAtMs - clockMs)}</span>
      </>
    );
  } else if (phase === "open") {
    label = (
      <>
        Extraction open —{" "}
        <span className={clsx("tabular-nums", urgent ? "text-rose-400" : "text-zooa-lime")}>{fmtClock(left)}</span> left
      </>
    );
  } else {
    label = "Raid over";
  }

  return (
    <div
      className={clsx(
        "toon-panel flex items-center gap-3 px-4 py-2 text-base tracking-wide md:text-lg",
        urgent && "animate-pulse bg-[#3a1620]/95",
      )}
    >
      <span
        className={clsx(
          "h-3 w-3 shrink-0 rounded-full border-2 border-black",
          phase === "open" ? "bg-zooa-lime" : phase === "drop" ? "bg-amber-400" : "bg-zinc-500",
        )}
        aria-hidden
      />
      <span className="toon-text-thin whitespace-nowrap">{label}</span>
      <span className="h-6 w-[3px] rounded bg-black/60" aria-hidden />
      <span className="flex items-center gap-1.5 whitespace-nowrap" title="Players alive on the map">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/sprites/player.png" alt="" className="h-6 w-6" draggable={false} />
        <span className="toon-text-thin tabular-nums">
          {snapshot.aliveCount}
          <span className="text-white/60">/{snapshot.totalPlayers}</span>
        </span>
      </span>
    </div>
  );
}

function ExtractCompass({ target }: { target: NonNullable<HudSnapshot["nearestExtract"]> }) {
  const deg = (Math.atan2(target.dy, target.dx) * 180) / Math.PI;
  const meters = Math.max(0, Math.round(target.dist / PX_PER_METER));
  return (
    <div
      className={clsx(
        "toon-chip flex items-center gap-2 py-1 pl-1.5 pr-3 text-sm tracking-wide",
        target.open ? "text-zooa-lime" : "text-white/70",
      )}
      title={target.open ? "Nearest open extraction point" : "Nearest extraction point (not open yet)"}
    >
      <span
        className={clsx(
          "grid h-7 w-7 place-items-center rounded-full border-2 border-black",
          target.open ? "bg-zooa-lime" : "bg-zinc-400",
        )}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5 transition-transform duration-100"
          style={{ transform: `rotate(${deg}deg)` }}
          aria-hidden
        >
          <path d="M3 12h13M12 6l7 6-7 6" fill="none" stroke="#000" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="toon-text-thin whitespace-nowrap">
        {target.open ? "Extract" : "Extract (closed)"} <span className="tabular-nums text-white">{meters} m</span>
      </span>
    </div>
  );
}

function KillFeed({
  entries,
  clockMs,
  selfNickname,
}: {
  entries: KillFeedEntry[];
  clockMs: number;
  selfNickname: string;
}) {
  const fresh = entries
    .filter((e) => clockMs - e.atMs < KILL_FEED_TTL_MS)
    .slice(-KILL_FEED_MAX)
    .reverse();
  if (fresh.length === 0) return null;
  return (
    <ol className="absolute left-3 top-3 flex max-w-[min(22rem,40vw)] flex-col gap-1.5" aria-label="Kill feed">
      {fresh.map((e) => (
        <li
          key={e.id}
          className="toon-chip flex items-center gap-2 px-3 py-1 text-sm tracking-wide animate-outcome-enter"
        >
          {e.killer ? (
            <>
              <Name name={e.killer} self={e.killer === selfNickname} />
              {e.weapon && isWeaponId(e.weapon) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={weaponIcon(e.weapon)} alt={WEAPONS[e.weapon].name} className="h-6 w-10 object-contain" draggable={false} />
              ) : (
                <span className="text-white/60">killed</span>
              )}
              <Name name={e.victim} self={e.victim === selfNickname} victim />
            </>
          ) : (
            <>
              <Name name={e.victim} self={e.victim === selfNickname} victim />
              <span className="text-white/60">died</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

function Name({ name, self, victim }: { name: string; self: boolean; victim?: boolean }) {
  return (
    <span
      className={clsx(
        "toon-text-thin max-w-[9rem] truncate",
        self ? "text-amber-300" : victim ? "text-rose-300" : "text-white",
      )}
    >
      {name}
    </span>
  );
}

/* --------------------------------------------------------------- center */

function ExtractRing({
  clockMs,
  startedAtMs,
  channelMs,
}: {
  clockMs: number;
  startedAtMs: number;
  channelMs: number;
}) {
  const pct = clamp01((clockMs - startedAtMs) / Math.max(1, channelMs));
  const secsLeft = Math.max(0, (channelMs - (clockMs - startedAtMs)) / 1000);
  const R = 52;
  const C = 2 * Math.PI * R;
  return (
    <div className="absolute bottom-[clamp(13rem,30vh,17rem)] left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
      <div className="relative h-32 w-32">
        <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90" aria-hidden>
          <circle cx="64" cy="64" r={R} fill="rgba(13,17,26,0.85)" stroke="#000" strokeWidth="18" />
          <circle cx="64" cy="64" r={R} fill="none" stroke="#2a3346" strokeWidth="11" />
          <circle
            cx="64"
            cy="64"
            r={R}
            fill="none"
            stroke="#CCFF00"
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={C * (1 - pct)}
          />
        </svg>
        <div className="absolute inset-0 grid place-items-center">
          <span className="toon-text text-3xl tabular-nums text-zooa-lime">{secsLeft.toFixed(1)}</span>
        </div>
      </div>
      <div className="toon-chip px-4 py-1.5 text-center text-sm tracking-wide">
        <span className="toon-text-thin text-zooa-lime">Extracting</span>
        <span className="text-white/70"> — stay in the circle, damage restarts it</span>
      </div>
    </div>
  );
}

function InteractHint({ hint }: { hint: string }) {
  // Renderer formats hints as "F — <action>"; show the key as a keycap.
  const m = /^F\s*[—–-]\s*(.+)$/.exec(hint);
  return (
    <div className="toon-chip flex items-center gap-2 px-3 py-1.5 text-sm tracking-wide md:text-base">
      <span className="toon-key">F</span>
      <span className="toon-text-thin">{m ? m[1] : hint}</span>
    </div>
  );
}

function ActionProgress({ self, clockMs }: { self: HudSelf; clockMs: number }) {
  let label: string | null = null;
  let start = 0;
  let until = 0;
  let color = "#ffc21a";
  if (self.reloading) {
    label = "Reloading";
    start = self.reloading.startMs;
    until = self.reloading.untilMs;
  } else if (self.healing) {
    label = self.healing.kind === "medkit" ? "Using medkit" : "Bandaging";
    start = self.healing.startMs;
    until = self.healing.untilMs;
    color = "#4ade80";
  }
  if (!label) return null;
  const pct = clamp01((clockMs - start) / Math.max(1, until - start));
  const left = Math.max(0, (until - clockMs) / 1000);
  return (
    <div className="toon-panel flex w-64 items-center gap-2 px-2.5 py-1.5">
      <span className="toon-text-thin w-24 shrink-0 text-xs tracking-wide">{label}</span>
      <div className="relative h-3.5 flex-1 overflow-hidden rounded-full border-2 border-black bg-black/60">
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-white/80">{left.toFixed(1)}s</span>
    </div>
  );
}

/* --------------------------------------------------------------- bottom */

function BottomBar({ self }: { self: HudSelf }) {
  return (
    <div className="flex items-end gap-2 md:gap-3">
      <VitalsPanel self={self} />
      <WeaponSlotCard slot={self.slots[0]} index={0} active={self.active === 0} reserve={reserveFor(self, self.slots[0])} />
      <WeaponSlotCard slot={self.slots[1]} index={1} active={self.active === 1} reserve={reserveFor(self, self.slots[1])} />
      <MedsPanel self={self} />
    </div>
  );
}

function reserveFor(self: HudSelf, slot: HudSlot): number {
  if (!slot.weapon) return 0;
  return self.ammo[WEAPONS[slot.weapon].ammo];
}

function VitalsPanel({ self }: { self: HudSelf }) {
  const hpPct = clamp01(self.hp / Math.max(1, self.maxHp));
  const hpColor = hpPct > 0.6 ? "#4ade80" : hpPct > 0.3 ? "#facc15" : "#f43f5e";
  const armorPct = self.armor > 0 ? clamp01(self.armorDur / Math.max(1, self.armorMax)) : 0;
  return (
    <div className="toon-panel flex w-[15.5rem] flex-col gap-2 p-2.5 md:w-[17rem]">
      <div className="flex items-center gap-2">
        <span className="toon-text-thin w-9 text-sm text-rose-300">HP</span>
        <Bar pct={hpPct} color={hpColor} height="h-6" />
        <span className="toon-text-thin w-10 text-right text-lg tabular-nums">{Math.ceil(self.hp)}</span>
      </div>
      <div className={clsx("flex items-center gap-2", self.armor === 0 && "opacity-50")}>
        <span className="relative grid h-9 w-9 shrink-0 place-items-center">
          {self.armor > 0 ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={armorIcon(self.armor)} alt="" className="h-9 w-9 object-contain" draggable={false} />
          ) : (
            <span className="h-7 w-7 rounded-lg border-2 border-dashed border-white/40" />
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
}: {
  slot: HudSlot;
  index: 0 | 1;
  active: boolean;
  reserve: number;
}) {
  const weapon = slot.weapon as WeaponId | "";
  if (!weapon) {
    return (
      <div className="relative grid h-[6.5rem] w-24 place-items-center rounded-2xl border-[3px] border-dashed border-black/80 bg-[#1d2333]/60 md:w-28">
        <span className="toon-key absolute left-1.5 top-1.5">{index + 1}</span>
        <span className="text-xs tracking-wide text-white/50">Empty</span>
      </div>
    );
  }
  const color = rarityHex(slot.rarity);
  const def = WEAPONS[weapon];
  return (
    <div
      className={clsx(
        "relative flex h-[6.5rem] w-24 flex-col items-center justify-between rounded-2xl border-[3px] border-black px-1.5 pb-1.5 pt-1 shadow-[0_4px_0_#000] transition-transform duration-150 md:w-28",
        active ? "-translate-y-2" : "opacity-80",
      )}
      style={{
        background: `linear-gradient(180deg, ${color}66 0%, #1d2333f0 70%)`,
        // Inline because Tailwind rings are box-shadows too and would be overwritten by the glow.
        boxShadow: active ? `0 0 0 3px #CCFF00, 0 6px 0 #000, 0 0 24px ${color}aa` : undefined,
      }}
      title={`${def.name} — ${rarityName(slot.rarity)}${slot.free ? " (free kit)" : ""}`}
    >
      <span className="toon-key absolute left-1.5 top-1.5">{index + 1}</span>
      <span
        className="toon-text-thin absolute right-1.5 top-1.5 text-[0.6rem] uppercase tracking-wider"
        style={{ color: slot.free ? "#d4d4d8" : color }}
      >
        {slot.free ? "Free" : rarityName(slot.rarity)}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={weaponIcon(weapon)} alt={def.name} className="mt-5 h-11 w-20 object-contain drop-shadow-[0_2px_0_rgba(0,0,0,0.6)]" draggable={false} />
      <div className="flex items-baseline gap-1 tabular-nums">
        <span className={clsx("toon-text-thin text-xl", slot.mag === 0 ? "text-rose-400" : "text-white")}>{slot.mag}</span>
        <span className="text-xs text-white/70">/ {reserve}</span>
      </div>
    </div>
  );
}

function MedsPanel({ self }: { self: HudSelf }) {
  return (
    <div className="toon-panel flex flex-col gap-1.5 p-2">
      <MedRow icon="/sprites/bandage.png" count={self.bandages} max={HEAL.bandage.MAX_CARRY} keyHint="3" label="Bandage +25 HP" />
      <MedRow icon="/sprites/medkit.png" count={self.medkits} max={HEAL.medkit.MAX_CARRY} keyHint="4" label="Medkit +75 HP" />
    </div>
  );
}

function MedRow({
  icon,
  count,
  max,
  keyHint,
  label,
}: {
  icon: string;
  count: number;
  max: number;
  keyHint: string;
  label: string;
}) {
  return (
    <div className={clsx("flex items-center gap-1.5", count === 0 && "opacity-45")} title={`${label} (max ${max})`}>
      <span className="toon-key">{keyHint}</span>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={icon} alt="" className="h-8 w-8 object-contain" draggable={false} />
      <span className="toon-text-thin w-6 text-lg tabular-nums">{count}</span>
    </div>
  );
}

/* -------------------------------------------------------------- corners */

function PingBadge({ pingMs }: { pingMs: number | null }) {
  const tone =
    pingMs == null ? "bg-zinc-500" : pingMs < 100 ? "bg-emerald-400" : pingMs < 200 ? "bg-amber-400" : "bg-rose-500";
  return (
    <div
      className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-1 text-[0.65rem] tabular-nums text-white/75"
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
  ["F", "Open chest / pick up"],
  ["1 / 2", "Switch weapon"],
  ["3", "Bandage"],
  ["4", "Medkit"],
];

function ControlsHelp({ onLeave }: { onLeave: () => void }) {
  const [open, setOpen] = useState(true);
  const [confirmLeave, setConfirmLeave] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem(HELP_STORAGE_KEY) === "0") setOpen(false);
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
    <div className="pointer-events-auto absolute bottom-3 right-3 flex flex-col items-end gap-2">
      {open && (
        <div className="toon-panel w-56 p-3 text-xs">
          <ul className="space-y-1.5">
            {CONTROLS.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2">
                <span className="text-white/75">{v}</span>
                <span className="toon-key">{k}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t-2 border-black/50 pt-2 text-[0.65rem] leading-snug text-white/55">
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
        className="toon-chip px-3 py-1.5 text-xs tracking-wide text-white transition hover:brightness-125"
      >
        {open ? "Hide controls" : "Controls"}
      </button>
    </div>
  );
}

function LowHpVignette({ hp, maxHp }: { hp: number; maxHp: number }) {
  const t = 1 - clamp01(hp / Math.max(1, maxHp) / 0.35);
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
