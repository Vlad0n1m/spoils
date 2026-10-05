"use client";

import Link from "next/link";
import { useTouchMode } from "./use-touch-mode";
import {
  BACKPACK_SLOTS,
  BREAK_CHANCE_ON_DEATH,
  INPUT_DT_MS,
  MARKET,
  MATCH,
  PLAYER,
  POCKET_SLOTS,
  ROLL,
  WORLD,
  XP,
  xpToNext,
} from "@extract/shared";
import { MARKET_CURRENCY } from "@/lib/market/config";
import { BRAND } from "@/lib/brand";

const min = (ms: number) => Math.round(ms / 60_000);
const CYCLE_MIN = min(WORLD.CYCLE_MS);
const CLOSE_MIN = min(WORLD.ENTRY_CLOSE_MS);
const ARM_MIN = min(WORLD.EXTRACT_ARM_MS);
const EARLY_MIN = min(WORLD.EXTRACT_EARLY_CLOSE_MS);
const GROUND_MIN = min(WORLD.GROUND_EXPIRE_MS);
const CORPSE_MIN = min(WORLD.CORPSE_EXPIRE_MS);
const ROLL_CD_S = Math.round((ROLL.COOLDOWN_TICKS * INPUT_DT_MS) / 1000);
const BAGS = BACKPACK_SLOTS.filter((n) => n > 0).join(" / ");
const BREAK_PCT = Math.round(BREAK_CHANCE_ON_DEATH * 100);
const CUR = MARKET_CURRENCY.code;

/** World rules, short enough to read in the lobby. Every number comes from the shared constants. */
const STEPS: { title: string; body: string; icon: string }[] = [
  {
    title: "Drop in",
    icon: "/sprites/pistol.png",
    body: `${BRAND.mapName} is always on. Drop in any time: the map wipes every ${CYCLE_MIN} minutes and entry closes ${CLOSE_MIN} minutes before the wipe. You drop with your loadout or the basic gear (a pistol, light ammo and a bandage; that pistol never breaks and never drops). ${PLAYER.MAX_HP} HP.`,
  },
  {
    title: "Search",
    icon: "/sprites/crate.png",
    body: "Walk up to a crate, safe or body and press F. It takes a moment to open, then items reveal one by one — rarer ones take longer. Click an item to take it or press T to take all; Tab opens your inventory.",
  },
  {
    title: "Move quietly",
    icon: "/sprites/shotgun.png",
    body: `Space rolls (${ROLL_CD_S} s cooldown). Shift walks quietly: half speed, short footstep range. Sounds you hear show up as markers around you — steps, shots, looting, extracts — with an arrow when it is behind you. On a phone the left stick moves and the right stick aims: firing is automatic while the aim line is on an enemy (never on party mates).`,
  },
  {
    title: "Locals",
    icon: "/sprites/boss.png",
    body: `Everyone else on the map is a real player — up to ${WORLD.CAPACITY} at once, and nobody fills empty seats. The rest are NPCs: marauder squads hold the towns and road camps. Bosses are events: about one map in three, announced in the lobby, holding their spot with guards. NPCs fight whoever comes close and drop scarce loot; they never loot or extract.`,
  },
  {
    title: "Carry",
    icon: "/sprites/backpack_2.png",
    body: `${POCKET_SLOTS} pockets plus a backpack (${BAGS} slots); ammo, meds and junk stack in a slot. Heal with 3 (bandage) or 4 (medkit), switch guns with 1 / 2. Junk you bring out is sold automatically for CR.`,
  },
  {
    title: "Extract",
    icon: "/sprites/backpack.png",
    body: `Your extracts arm ${ARM_MIN} minutes after you drop in. Stand in one for ${MATCH.EXTRACT_CHANNEL_MS / 1000} s to get out with everything you carry; taking damage restarts the countdown, and some extracts close ${EARLY_MIN} minutes before the wipe. Extracted or dead, you can drop in again with a fresh loadout, up to ${WORLD.MAX_ENTRIES_PER_CYCLE} times per map.`,
  },
  {
    title: "Don't get caught",
    icon: "/sprites/corpse.png",
    body: `Die and you leave a body with your gear: each item on it has a ${BREAK_PCT}% chance to break, the rest is loot for whoever searches you. Still on the map when it wipes? You're caught in the wipe and lose everything you carry.`,
  },
];

/**
 * Info · How to play (WORLD v6 spec §6.3). The sections are `paged-group`s: inside the Info panel
 * every step, block and note is its own item of the paged columns (components/paged.tsx).
 */
export function PlayerInstructions() {
  return (
    <section aria-label="How to play" className="paged-group">
      <p className="font-body text-base leading-relaxed text-white/75">Top-down extraction shooter: drop in, loot up, get out alive.</p>
      <ol className="paged-group list-none">
        {STEPS.map((s, i) => (
          <li key={s.title} className="flex gap-4 pt-2">
            <span className="relative grid h-14 w-14 shrink-0 place-items-center rounded-2xl border-[3px] border-black bg-white/[0.07] shadow-[0_3px_0_#000]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={s.icon} alt="" className="h-11 w-11 object-contain" draggable={false} />
              <span className="toon-key absolute -left-2 -top-2 h-5 min-w-5 bg-zooa-lime text-xs">{i + 1}</span>
            </span>
            <div className="min-w-0">
              <h3 className="text-lg tracking-wide text-white">{s.title}</h3>
              <p className="font-body mt-1.5 text-[0.95rem] leading-relaxed text-white/75 short:text-sm short:leading-snug">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="font-body rounded-xl border-2 border-black bg-amber-300 px-3 py-2 text-sm font-bold text-black">
        Items left on the ground vanish after {GROUND_MIN} min, bodies after {CORPSE_MIN} min — valuables go to the treasury.
      </p>
    </section>
  );
}

const XP_ROWS: Array<[string, string]> = [
  ["Extract", `${XP.EXTRACT_BASE} + ${XP.EXTRACT_PER_MIN} per minute on the map (up to ${XP.EXTRACT_MAX_MIN} min), after ${min(XP.MIN_ONMAP_MS)}+ minutes on the map`],
  ["Haul", `1 per ${XP.HAUL_CR_PER_XP} CR of junk sold (up to ${XP.HAUL_MAX}), same ${min(XP.MIN_ONMAP_MS)}-minute rule`],
  ["Container searched", `${XP.CONTAINER} each (up to ${XP.CONTAINER_MAX} containers per drop)`],
  ["Marauder", `${XP.NPC}`],
  ["Guard", `${XP.GUARD}`],
  ["Boss", `${XP.BOSS}`],
  [
    "Raider",
    `${XP.PVP} for a raider of level ${XP.PVP_VICTIM_MIN_LEVEL}+ whose account is ${Math.round(XP.PVP_VICTIM_MIN_AGE_MS / 3_600_000)}+ hours old (at most ${XP.PVP_PAIR_PER_DAY} per opponent and ${XP.PVP_DAILY_MAX} in all a day)`,
  ],
  ["First extract of the day", `doubles that drop (up to +${XP.FIRST_EXTRACT_MAX})`],
];

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="paged-split toon-panel bg-[#161b28]/95 p-4 md:p-5 short:!p-3">
      <h3 className="toon-text-thin text-xl tracking-wide text-white short:text-lg">{title}</h3>
      <div className="font-body mt-3 text-[0.95rem] leading-relaxed text-white/75 short:mt-2 short:text-sm short:leading-snug">{children}</div>
    </section>
  );
}

/** Info · Rules (WORLD v6 spec §6.3): currencies, risk, XP table, boards, ground expiry. */
export function RulesSection() {
  return (
    <div className="paged-group">
      <Block title="Two currencies">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-bold text-amber-300">CR</dt>
          <dd>Earned from junk you bring out (sold automatically). Spent at the traders on ammo, meds and bound gear. Credits never convert to {CUR}.</dd>
          <dt className="font-bold text-sol-400">{CUR}</dt>
          <dd>
            Your market wallet: buy and sell gear with other raiders ({MARKET.FEE_BPS / 100}% fee on sales). Selling unlocks at level{" "}
            {MARKET.SELL_UNLOCK_LEVEL}. The game never pays {CUR} out by itself.
          </dd>
        </dl>
      </Block>
      <Block title="Risk">
        <p>
          Gear you bring is at risk: die and each item has a {BREAK_PCT}% chance to break; the rest stays on your body. Lost
          gear goes to the lost pool and comes back onto the map — in containers and on marauders — when raiders drop in
          with real gear. Basic gear risks nothing and brings nothing back.
        </p>
        <p className="mt-2">
          Items left on the ground vanish after {GROUND_MIN} min, bodies after {CORPSE_MIN} min — valuables go to the treasury.
        </p>
      </Block>
      <Block title="Experience">
        <table className="w-full text-left text-sm">
          <tbody>
            {XP_ROWS.map(([k, v]) => (
              <tr key={k} className="border-t border-white/10 first:border-t-0">
                <th scope="row" className="py-1.5 pr-3 align-top font-bold text-white">
                  {k}
                </th>
                <td className="py-1.5">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-sm">
          No XP for time alive or for dropping in. After {XP.DAILY_SOFT_CAP.toLocaleString("en-US")} XP a day from extracts, hauls,
          containers, marauders and guards, extracts and hauls give no more XP that day and the rest give a quarter. Caught in
          the wipe: kill XP only. Level 2 takes{" "}
          {xpToNext(1)} XP, and each next level {xpToNext(2) - xpToNext(1)} more.
        </p>
      </Block>
      <Block title="Leaderboards">
        <p>Level (all time), Raider kills and NPC kills, for this map, this week or all time. Guests aren&apos;t ranked. No prizes: the boards are for bragging.</p>
      </Block>
      <Link href="/economy" className="font-body block w-fit rounded-lg px-1 text-sm font-semibold text-zooa-lime underline-offset-4 hover:underline">
        Live economy stats →
      </Link>
    </div>
  );
}

const KEYS: Array<[string[], string]> = [
  [["W", "A", "S", "D"], "Move"],
  [["Mouse"], "Aim · left button fires"],
  [["R"], "Reload"],
  [["F"], "Search / interact"],
  [["T"], "Take all"],
  [["Tab"], "Inventory"],
  [["Space"], `Roll (${ROLL_CD_S} s cooldown)`],
  [["Shift"], "Walk quietly"],
  [["1", "2"], "Switch weapon"],
  [["3"], "Bandage"],
  [["4"], "Medkit"],
  [["G", "5"], "Throw grenade (at the cursor)"],
  [["M"], "Full map"],
  [["Esc"], "Close a panel"],
];

const MENU_KEYS: Array<[string, string]> = [
  ["I", "Inventory"],
  ["B", "Shop"],
  ["L", "Leaderboards"],
  ["N", "News"],
  ["H", "Info"],
];

/** Phones (touch mode): the sticks and buttons of game/touch-controls.ts. */
const TOUCH_KEYS: Array<[string, string]> = [
  ["Left stick", "Move · push it part way to walk quietly"],
  ["Right stick", "Aim · firing is automatic: your gun shoots while the aim line is on an enemy (the reticle turns red), never at party mates"],
  ["ROLL", `Dodge roll (${ROLL_CD_S} s cooldown)`],
  ["USE", "Search / pick up"],
  ["Reload · swap", "Reload · switch weapon"],
  ["Bandage · medkit", "Heal"],
  ["Grenade", "Tap: throw ahead · drag: aim and range"],
  ["Bag · MAP", "Inventory · full map"],
];

function TouchControlsBlock() {
  return (
    <Block title="On a phone">
      <ul className="divide-y divide-white/10">
        {TOUCH_KEYS.map(([k, what]) => (
          <li key={k} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
            <span>{what}</span>
            <span className="toon-key shrink-0 px-1.5 font-sans text-xs">{k}</span>
          </li>
        ))}
      </ul>
    </Block>
  );
}

/** Info · Controls (WORLD v6 spec §6.3). Phones see their touch controls first. */
export function ControlsSection() {
  const touch = useTouchMode();
  return (
    <div className="paged-group">
      {touch && <TouchControlsBlock />}
      <Block title="In a raid">
        <ul className="divide-y divide-white/10">
          {KEYS.map(([keys, what]) => (
            <li key={what} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
              <span>{what}</span>
              <span className="flex shrink-0 gap-1">
                {keys.map((k) => (
                  <kbd key={k} className="toon-key px-1.5 font-sans text-xs">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </Block>
      <Block title="In the menu">
        <ul className="divide-y divide-white/10">
          {MENU_KEYS.map(([k, what]) => (
            <li key={k} className="flex min-h-10 items-center justify-between gap-3 py-1.5">
              <span>{what}</span>
              <kbd className="toon-key px-1.5 font-sans text-xs">{k}</kbd>
            </li>
          ))}
        </ul>
      </Block>
      {!touch && <TouchControlsBlock />}
    </div>
  );
}
