"use client";

/**
 * /dev/inventory — bench for the in-raid inventory UI (dev builds only). Runs the real
 * InventoryClient + InventoryOverlay against FakeInventoryRoom (an in-browser imitation of the
 * server's inventory rules with fake latency), plus the v2 outcome overlay with sample outcomes.
 */

import { useEffect, useMemo, useState } from "react";
import { ITEM_FLAG, SEARCH, type OutcomeMsg, type SettledItem } from "@extract/shared";
import { bindInventoryHotkeys, createInventoryClient, type InventoryClient } from "@/game/inventory-client";
import { InventoryOverlay } from "@/components/inventory/inventory-overlay";
import {
  FakeInventoryRoom,
  devChestLoot,
  devCorpseLoot,
  devStartingGear,
  fakeItem,
} from "@/components/inventory/dev-fake-room";
import { MatchOutcomeOverlay, type FinalCredits } from "@/components/match-outcome-overlay";

export default function InventoryDevPage() {
  if (process.env.NODE_ENV === "production") {
    return <main className="p-8 font-mono text-sm text-white/70">Not available in production builds.</main>;
  }
  return <InventoryBench />;
}

const CONTAINERS = [
  { kind: "crate" as const, tier: 1 as const },
  { kind: "safe" as const, tier: 3 as const },
];

function settled(def: string, extra: Partial<SettledItem> = {}): SettledItem {
  return { uid: "", def, qty: 1, rarity: 0, dur: 0, ...extra };
}

const OUTCOMES: Record<string, OutcomeMsg> = {
  extract: {
    matchId: "m1", exit: "extract", killedBy: "", kills: 3, atMs: 17 * 60_000 + 12_000, guest: false,
    extracted: [
      settled("rifle", { uid: "a", rarity: 2, dur: 71 }),
      settled("armor_2", { uid: "b", dur: 40, rarity: 1 }),
      settled("backpack_2", { uid: "c", rarity: 1 }),
      settled("ammo_light", { qty: 47 }),
      settled("bandage", { qty: 2 }),
      settled("junk_gpu", { rarity: 3 }),
      settled("junk_bolts", { qty: 4 }),
      settled("junk_canned", { qty: 3 }),
      settled("junk_dogtag", { label: "Krolik", lvl: 7, rarity: 1 }),
      settled("junk_dogtag", { label: "Sasha", lvl: 12, rarity: 1 }),
    ],
    lost: [], dropped: [], credits: 0, sold: [],
  },
  dead: {
    matchId: "m1", exit: "dead", killedBy: "Viper", kills: 1, atMs: 9 * 60_000 + 40_000, guest: false,
    extracted: [],
    lost: [settled("sniper", { uid: "s", rarity: 3, dur: 40 }), settled("armor_3", { uid: "a3", dur: 120, rarity: 2 })],
    dropped: [settled("shotgun", { uid: "sg", rarity: 1, dur: 64 }), settled("ammo_heavy", { qty: 14 }), settled("junk_coldwallet", { rarity: 3 })],
    credits: 0, sold: [],

    recap: {
      killer: { kind: "human", name: "Viper", role: 0, weapon: "rifle", rarity: 2, distM: 34, hp: 37, hpMax: 100, party: true },
      sources: [
        { who: "killer", name: "Viper", role: 0, weapon: "rifle", rarity: 2, dmg: 64, hits: 3 },
        { who: "party", name: "", role: 0, weapon: "grenade", rarity: -1, dmg: 40, hits: 1 },
        { who: "npc", name: "Marauder", role: 3, weapon: "pistol", rarity: 0, dmg: 12, hits: 2 },
        { who: "other", name: "", role: 0, weapon: "", rarity: -1, dmg: 9, hits: 3 },
      ],
      total: 125, windowMs: 10_000,
    },
  },
  "dead-npc": {
    matchId: "m1", exit: "dead", killedBy: "Foreman", kills: 0, atMs: 21 * 60_000 + 5_000, guest: false,
    extracted: [], lost: [], dropped: [], credits: 0, sold: [],
    recap: {
      killer: { kind: "npc", name: "Foreman", role: 1, boss: "foreman", weapon: "shotgun", rarity: 3, party: false },
      sources: [
        { who: "killer", name: "Foreman", role: 1, weapon: "shotgun", rarity: 3, dmg: 78, hits: 4 },
        { who: "npc", name: "Elevator thug", role: 2, weapon: "smg", rarity: 1, dmg: 22, hits: 5 },
      ],
      total: 100, windowMs: 10_000,
    },
  },
  "dead-guest": {
    matchId: "m1", exit: "dead", killedBy: "Guest4821", kills: 0, atMs: 31 * 60_000, guest: true,
    extracted: [], lost: [], dropped: [settled("ammo_light", { qty: 30 })], credits: 0, sold: [],
    recap: {
      killer: { kind: "human", name: "Guest4821", role: 0, weapon: "sniper", rarity: 0, party: false, guest: true },
      sources: [{ who: "killer", name: "Guest4821", role: 0, weapon: "sniper", rarity: 0, dmg: 100, hits: 2 }],
      total: 100, windowMs: 10_000,
    },
  },
  timeout: {
    matchId: "m1", exit: "timeout", killedBy: "", kills: 0, atMs: 30 * 60_000, guest: false,
    extracted: [], lost: [settled("rifle", { uid: "r", rarity: 1, dur: 90 }), settled("junk_hdd", { qty: 2, rarity: 2 })],
    dropped: [], credits: 0, sold: [],
  },
  guest: {
    matchId: "m1", exit: "extract", killedBy: "", kills: 0, atMs: 6 * 60_000, guest: true,
    extracted: [settled("junk_goldchain", { rarity: 2 }), settled("junk_apple", { qty: 5 })],
    lost: [], dropped: [], credits: 0, sold: [],
  },
};

function InventoryBench() {
  const room = useMemo(() => {
    const r = new FakeInventoryRoom();
    devStartingGear(r);
    return r;
  }, []);
  const [client, setClient] = useState<InventoryClient | null>(null);
  const [outcomeKey, setOutcomeKey] = useState<string | null>(null);
  // ?outcome=<key> opens that sample at once (screenshots of the outcome card).
  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get("outcome");
    if (k && OUTCOMES[k]) setOutcomeKey(k);
  }, []);
  const [final, setFinal] = useState<FinalCredits | null>(null);

  useEffect(() => {
    const c = createInventoryClient({ room, selfKey: () => room.selfKey, containers: () => CONTAINERS });
    setClient(c);
    const unbind = bindInventoryHotkeys(c);
    const iv = window.setInterval(() => room.tick(50), 50);
    return () => {
      window.clearInterval(iv);
      unbind();
      c.dispose();
    };
  }, [room]);

  const corpse = () => room.openSearch("kbody1", devCorpseLoot(), SEARCH.OPEN_MS.corpse, "Sasha");
  const chest = () => room.openSearch("c1", devChestLoot(), 2300);
  const crate = () =>
    room.openSearch("c0", [fakeItem("junk_apple", { qty: 2 }), fakeItem("junk_water"), fakeItem("bandage", { qty: 1 })], 800);
  const fill = () => {
    const s = room.me.slots;
    for (let i = 0; i < 10; i++) if (!s.get(`b${i}`)) s.set(`b${i}`, fakeItem("junk_fuel"));
    for (let i = 0; i < 4; i++) if (!s.get(`p${i}`)) s.set(`p${i}`, fakeItem("junk_keycard"));
    room.patch();
  };
  const reset = () => {
    room.me.slots.clear();
    room.me.searching = "";
    room.state.loot.clear();
    devStartingGear(room);
    room.patch();
  };
  const breakW1 = () => {
    const w = room.me.slots.get("w1");
    if (w) w.dur = Math.max(1, w.dur - 25);
    room.patch();
  };

  const outcome = outcomeKey ? OUTCOMES[outcomeKey]! : null;

  return (
    <main className="min-h-[100dvh] bg-[#0b0f0a] bg-[radial-gradient(circle_at_30%_20%,#1b2a17,transparent_60%)] p-4 text-white sm:p-6">
      <div className="toon-panel fixed inset-x-3 bottom-3 z-[80] mx-auto flex max-w-5xl flex-wrap items-center gap-2 p-3">
        <h1 className="toon-text mr-2 text-2xl tracking-wide">Inventory bench</h1>
        <DevBtn onClick={() => client?.toggle()}>Inventory [Tab]</DevBtn>
        <DevBtn onClick={corpse}>Search body</DevBtn>
        <DevBtn onClick={chest}>Search safe</DevBtn>
        <DevBtn onClick={crate}>Search crate</DevBtn>
        <DevBtn onClick={() => room.stealLoot(0)}>Someone takes #1</DevBtn>
        <DevBtn onClick={fill}>Fill bag</DevBtn>
        <DevBtn onClick={breakW1}>Wear W1</DevBtn>
        <DevBtn onClick={reset}>Reset</DevBtn>
        <span className="mx-2 h-6 w-px bg-white/20" />
        {Object.keys(OUTCOMES).map((k) => (
          <DevBtn key={k} onClick={() => { setFinal(null); setOutcomeKey(k); }}>
            Outcome: {k}
          </DevBtn>
        ))}
        <label className="font-body flex items-center gap-1.5 text-xs text-white/70">
          latency
          <input
            type="range"
            min={0}
            max={600}
            step={20}
            defaultValue={room.latencyMs}
            onChange={(e) => (room.latencyMs = Number(e.target.value))}
          />
        </label>
      </div>
      <p className="font-body mx-auto mt-3 max-w-5xl text-sm text-white/55">
        Fake server with latency; keys: Tab toggle, T take all, Esc close, arrows move focus, Del drop. Broken items use
        ITEM_FLAG.BROKEN = {ITEM_FLAG.BROKEN}.
      </p>

      {client && <InventoryOverlay client={client} />}

      <MatchOutcomeOverlay
        visible={!!outcome}
        outcome={outcome}
        settlement={{
          matchId: "m1",
          participants: [
            { nickname: "You", isBot: false, exitType: outcome?.exit ?? "extract", kills: 3 },
            { nickname: "Viper", isBot: false, exitType: "dead", kills: 2 },
            { nickname: "Kestrel", isBot: false, exitType: "extract", kills: 0 },
          ],
        }}
        raidEnded
        disconnected={false}
        finalCredits={final}
        onContinue={() => setOutcomeKey(null)}
      />
      {outcome?.exit === "extract" && !outcome.guest && (
        <div className="fixed bottom-4 right-4 z-[110] flex gap-2">
          <DevBtn onClick={() => setFinal({ credits: 2900, mult: 0.94 })}>Web final ×0.94</DevBtn>
        </div>
      )}
    </main>
  );
}

function DevBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="toon-btn-ghost h-9 px-3 text-sm">
      {children}
    </button>
  );
}
