"use client";

/**
 * Death recap card on the outcome screen (OutcomeMsg.recap): who killed you and with what — the
 * killer (nickname, NPC role name or boss), their weapon with its rarity, the distance (only when
 * you saw them), their HP left (only when you hit them), the squad / guest badges and the damage you
 * took in the last 10 s by source. A snapshot of the moment of death: nothing here moves afterwards.
 * Compact by design: it must fit a 844×390 phone in landscape next to the rest of the result.
 */

import clsx from "clsx";
import type { DeathRecap } from "@extract/shared";
import { isKillWeapon, killWeaponIcon, rarityHex } from "@/lib/items-ui";
import {
  recapBadges,
  recapKillerHp,
  recapKillerName,
  recapKillerSub,
  recapSourceWho,
  recapWeaponLabel,
} from "@/game/recap-text";
import { npcRoleName, npcRoleOfLabel } from "@/game/npc-labels";

export function DeathRecapCard({ recap, className }: { recap: DeathRecap; className?: string }) {
  const k = recap.killer;
  const icon = isKillWeapon(k.weapon) ? killWeaponIcon(k.weapon) : null;
  const ring = k.rarity >= 0 ? rarityHex(k.rarity) : "#5b6478";
  const hp = recapKillerHp(recap);
  const badges = recapBadges(recap);
  const npc = k.kind === "npc" ? (npcRoleName(k.role) ?? npcRoleOfLabel(k.name)) : null;
  const nameTone = npc === "boss" ? "text-rose-300" : npc ? "text-amber-200" : k.kind === "self" ? "text-white/80" : "text-white";
  return (
    <section
      aria-label="Death recap"
      className={clsx("rounded-xl border-[3px] border-black/70 bg-black/35 px-3 py-2.5 short:py-2", className)}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg border-[3px] bg-[#0f131c] short:h-10 short:w-14"
          style={{ borderColor: ring, boxShadow: k.rarity >= 2 ? `0 0 10px ${ring}66` : undefined }}
          title={recapWeaponLabel(k.weapon, k.rarity) || undefined}
        >
          {icon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={icon} alt="" className="max-h-9 max-w-[3.25rem] object-contain short:max-h-7" draggable={false} />
          ) : (
            <span className="toon-text-thin text-xl text-white/50" aria-hidden>?</span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-xs uppercase leading-none tracking-[0.22em] text-white/50">Killed by</p>
          <div className="flex min-w-0 items-center gap-2">
            <p className={clsx("toon-text-thin min-w-0 truncate text-2xl leading-none tracking-wide short:text-xl", nameTone)}>
              {recapKillerName(recap)}
            </p>
            {badges.map((b) => (
              <span
                key={b}
                className="font-body shrink-0 rounded-full border-2 border-black bg-sky-400/90 px-2 py-px text-xs font-bold text-black"
              >
                {b}
              </span>
            ))}
          </div>
          <p className="font-body truncate text-sm text-white/70 short:text-xs">{recapKillerSub(recap)}</p>
        </div>
      </div>

      {hp && k.hpMax ? (
        <div className="mt-2 flex items-center gap-2 short:mt-1.5" title="You hit them in your last 10 seconds">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full border-2 border-black bg-black/60">
            <div
              className="h-full rounded-full bg-rose-500"
              style={{ width: `${Math.max(2, Math.min(100, ((k.hp ?? 0) / k.hpMax) * 100))}%` }}
            />
          </div>
          <span className="font-body shrink-0 text-xs font-semibold tabular-nums text-rose-200">{hp}</span>
        </div>
      ) : null}

      {recap.sources.length > 0 && (
        <div className="mt-2 border-t-2 border-black/50 pt-1.5 short:mt-1.5 short:pt-1">
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-xs uppercase tracking-[0.18em] text-white/50">
              Damage taken · last {Math.round(recap.windowMs / 1000)} s
            </h3>
            <span className="font-body text-xs font-semibold tabular-nums text-white/70">{recap.total} total</span>
          </div>
          <ul className="font-body mt-1 flex flex-col gap-1 text-sm short:gap-0.5 short:text-xs">
            {recap.sources.map((s, i) => {
              const label = s.who === "other" ? "Other hits" : recapWeaponLabel(s.weapon, s.rarity) || "Hits";
              return (
                <li key={i} className="flex items-baseline gap-2 leading-snug">
                  <span
                    className="h-2.5 w-2.5 shrink-0 translate-y-px rounded-full border border-black"
                    style={{ background: s.rarity >= 0 ? rarityHex(s.rarity) : "#8a93a6" }}
                    aria-hidden
                  />
                  <span className="max-w-[62%] shrink-0 truncate text-white/90">{label}</span>
                  <span className="min-w-0 truncate text-white/50">{recapSourceWho(s, recap)}</span>
                  <span className="ml-auto shrink-0 tabular-nums font-semibold text-white">{s.dmg} dmg</span>
                  <span className="w-11 shrink-0 text-right tabular-nums text-xs text-white/55">
                    {s.hits} {s.hits === 1 ? "hit" : "hits"}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
