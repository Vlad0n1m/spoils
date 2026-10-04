"use client";

import clsx from "clsx";
import { XP_LINE_LABEL, type ExitType, type LastRaidDto, type XpLine } from "@extract/shared";
import { fmtCr } from "@/lib/items-ui";
import { fmtInt } from "./xp-bar";
import { mapLabel } from "@/lib/lobby/world-clock";

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
  return (
    <section
      aria-label="Last raid"
      className="toon-panel overflow-hidden bg-[#161b28]/95 animate-panel-in motion-reduce:animate-none"
    >
      <div className={clsx("h-2.5 border-b-[3px] border-black", exit.bar)} aria-hidden />
      <div className="p-4 [@media(max-height:500px)]:p-3">
        <p className="text-[0.65rem] tracking-[0.2em] text-white/55">LAST RAID · {mapLabel(raid.mapNumber).toUpperCase()}</p>
        <h2 className="toon-text-thin mt-1.5 text-2xl tracking-wide text-white">{exit.title}</h2>

        <details className="group mt-3 [@media(max-height:500px)]:mt-1">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zooa-lime [&::-webkit-details-marker]:hidden">
            <span className="toon-text-thin text-3xl tabular-nums tracking-wide text-zooa-lime">+{fmtInt(raid.xp)} XP</span>
            {raid.xpLines.length > 0 && (
              <span className="font-body text-xs font-semibold text-white/65 group-open:hidden">Details</span>
            )}
          </summary>
          {raid.xpLines.length > 0 && (
            <ul className="font-body mt-2 space-y-1 border-t-2 border-black/40 pt-2 text-sm">
              {raid.xpLines.map((l, i) => (
                <li key={`${l.key}-${i}`} className="flex justify-between gap-3 text-white/80">
                  <span className="min-w-0 truncate">{xpLineText(l)}</span>
                  <span className={clsx("shrink-0 tabular-nums font-semibold", l.xp < 0 ? "text-amber-300" : "text-white")}>
                    {l.xp < 0 ? "−" : "+"}
                    {fmtInt(Math.abs(l.xp))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>

        {raid.credits > 0 && <p className="toon-text-thin mt-2 text-xl tabular-nums tracking-wide text-amber-300">+{fmtCr(raid.credits)}</p>}
        <p className="font-body mt-2 text-sm text-white/75">Kills: {killsText(raid.kills)}</p>
        {raid.level > raid.levelBefore && (
          <p className="font-body mt-1 text-sm font-semibold text-zooa-lime">Level {raid.level} reached</p>
        )}
        <button type="button" onClick={onDismiss} className="toon-btn-ghost mt-4 min-h-11 w-full text-sm [@media(max-height:500px)]:mt-2">
          <span className="optical-center">Dismiss</span>
        </button>
      </div>
    </section>
  );
}
