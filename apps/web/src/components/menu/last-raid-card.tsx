"use client";

import { useEffect } from "react";
import clsx from "clsx";
import { XP_LINE_LABEL, type ExitType, type LastRaidDto, type XpLine } from "@extract/shared";
import { fmtCr } from "@/lib/items-ui";
import { fmtInt } from "./xp-bar";
import { mapLabel } from "@/lib/lobby/world-clock";
import { killedByText } from "@/game/recap-text";

const EXIT: Record<ExitType, { title: string; bar: string }> = {
  extract: { title: "Extracted!", bar: "bg-zooa-lime" },
  dead: { title: "Eliminated", bar: "bg-rose-500" },
  mia: { title: "Caught in the wipe", bar: "bg-amber-300" },
  timeout: { title: "Time's up", bar: "bg-amber-300" },
};

/** "Haul · 1 320 CR", "Marauders ×3", "Extracted · 12 min". */
export function xpLineText(l: XpLine): string {
  const label = XP_LINE_LABEL[l.key] ?? l.key;
  switch (l.key) {
    case "extract":
      return `${label} · ${l.qty} min`;
    case "haul":
      return `${label} · ${fmtCr(l.qty)}`;
    case "first_extract":
    case "daily_cap":
      return label;
    default:
      return l.qty > 1 ? `${label} ×${l.qty}` : label;
  }
}

/** XP lines listed before the rest fold into one "N more" line (the card never scrolls). */
const XP_LINES = 6;
const fmtSigned = (n: number) => `${n < 0 ? "−" : "+"}${fmtInt(Math.abs(n))}`;

/** "2 raiders · 7 NPCs (boss 1)"; "No kills" when there were none. */
export function killsText(k: LastRaidDto["kills"]): string {
  const parts: string[] = [];
  if (k.players > 0) parts.push(`${k.players} ${k.players === 1 ? "raider" : "raiders"}`);
  if (k.npcs > 0) parts.push(`${k.npcs} ${k.npcs === 1 ? "NPC" : "NPCs"}${k.bosses > 0 ? ` (boss ${k.bosses})` : ""}`);
  return parts.length ? parts.join(" · ") : "No kills";
}

/**
 * After-raid card (WORLD v6 spec §6.6): exit title, "+N XP" with the server's XP lines, "+N CR",
 * kills, Dismiss. Desktop: left of the hero; below lg a bottom sheet. Shown by the menu while the
 * newest raid's entryId differs from localStorage `spoils.lastRaidSeen`.
 */
export function LastRaidCard({ raid, onDismiss }: { raid: LastRaidDto; onDismiss: () => void }) {
  const exit = EXIT[raid.exit] ?? EXIT.dead;
  const levelUp = raid.level > raid.levelBefore;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  return (
    <section aria-label="Last raid" role="dialog" aria-modal="true" className="toon-panel overflow-hidden bg-[#161b28] p-0 shadow-[0_10px_0_#000]">
      <div className={clsx("flex items-center justify-between gap-3 border-b-[3px] border-black px-5 py-3", exit.bar)}>
        <h2 className="toon-text text-3xl tracking-wide text-white short:text-2xl">{exit.title}</h2>
        <span className="font-body shrink-0 rounded-full bg-black/80 px-2.5 py-1 text-xs font-bold tracking-wide text-white">
          {mapLabel(raid.mapNumber).toUpperCase()}
        </span>
      </div>
      <div className="p-5 short:p-3">
        <div className="grid grid-cols-3 gap-2">
          <Stat label="XP" value={`+${fmtInt(raid.xp)}`} tone="text-zooa-lime" />
          <Stat label="Credits" value={raid.credits > 0 ? `+${fmtCr(raid.credits)}` : "—"} tone="text-amber-300" />
          <Stat label="Kills" value={String(raid.kills.players + raid.kills.npcs)} tone="text-white" />
        </div>
        <p className="font-body mt-3 text-sm text-white/80 short:mt-2">{killsText(raid.kills)}</p>
        {raid.exit === "dead" && killedByText(raid.killedBy, raid.killedByRole) && (
          <p className="font-body mt-1 text-sm font-semibold text-rose-300">{killedByText(raid.killedBy, raid.killedByRole)}</p>
        )}
        {raid.trophies && raid.trophies.length > 0 && (
          <p className="font-body mt-2 text-sm font-bold text-amber-300">Boss trophy: {raid.trophies.join(", ")}</p>
        )}
        {levelUp && (
          <p className="toon-text-thin mt-3 rounded-xl border-[3px] border-black bg-zooa-lime px-3 py-2 text-center text-lg tracking-wide text-black">
            Level {raid.level} reached!
          </p>
        )}
        {raid.xpLines.length > 0 && (
          // No inner scroll: the first lines, then one "N more" line with the rest of the XP.
          <ul className="font-body mt-3 short:hidden space-y-1.5 rounded-xl border-2 border-black/50 bg-black/25 p-3 text-sm">
            {raid.xpLines.slice(0, raid.xpLines.length > XP_LINES ? XP_LINES - 1 : XP_LINES).map((l, i) => (
              <li key={`${l.key}-${i}`} className="flex justify-between gap-3 leading-snug text-white/85">
                <span className="min-w-0 truncate">{xpLineText(l)}</span>
                <span className={clsx("shrink-0 tabular-nums font-semibold", l.xp < 0 ? "text-amber-300" : "text-white")}>
                  {l.xp < 0 ? "−" : "+"}
                  {fmtInt(Math.abs(l.xp))} XP
                </span>
              </li>
            ))}
            {raid.xpLines.length > XP_LINES && (
              <li className="flex justify-between gap-3 leading-snug text-white/70">
                <span className="min-w-0 truncate">{raid.xpLines.length - XP_LINES + 1} more</span>
                <span className="shrink-0 tabular-nums font-semibold text-white">
                  {fmtSigned(raid.xpLines.slice(XP_LINES - 1).reduce((n, l) => n + l.xp, 0))} XP
                </span>
              </li>
            )}
          </ul>
        )}
        <button type="button" onClick={onDismiss} autoFocus className="toon-btn mt-4 min-h-12 w-full text-lg tracking-wide short:mt-3">
          <span className="optical-center">Continue</span>
        </button>
      </div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="flex flex-col items-center rounded-xl border-[3px] border-black bg-[#1d2333] px-2 py-2">
      <span className={clsx("toon-text-thin text-2xl tabular-nums leading-none tracking-wide", tone)}>{value}</span>
      <span className="font-body mt-1 text-xs font-semibold uppercase tracking-wide text-white/75">{label}</span>
    </div>
  );
}
