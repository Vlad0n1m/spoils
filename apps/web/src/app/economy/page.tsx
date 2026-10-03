import type { Metadata } from "next";
import { TopBar } from "@/components/top-bar";
import { db } from "@/db/client";
import { getEconomyStats } from "@/lib/lobby/economy-stats";
import type { EconomyStatsDto } from "@/lib/lobby/api-types";
import { fmtCr } from "@/lib/items-ui";
import { formatMinor } from "@/lib/market/config";
import { BRAND } from "@/lib/brand";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Economy — ${BRAND.name}`,
  description: `Live numbers of the ${BRAND.name} economy: credits in and out, items in circulation, the lost pool, treasury and market trades.`,
};

/** Plain-language names of credit_ledger reasons. */
const REASON: Record<string, { label: string; note: string }> = {
  autosell: { label: "Junk sold at extraction", note: "faucet" },
  giveaway: { label: "Starter kits", note: "faucet" },
  consumables: { label: "Junker: ammo & meds", note: "sink" },
  bound: { label: "Trader gear (bound)", note: "sink" },
  listing_fee: { label: "Market listing fees", note: "sink" },
  admin: { label: "Admin adjustments", note: "—" },
};

const STATE: Array<{ key: string; label: string; note: string }> = [
  { key: "in_stash", label: "In stashes", note: "owned, ready to equip or sell" },
  { key: "listed", label: "Listed on the market", note: "player and treasury lots" },
  { key: "in_raid", label: "In raids", note: "locked loadouts and pool loot on the map" },
  { key: "lost_pool", label: "Lost pool", note: "broke on death or left behind; re-enters raids as loot" },
  { key: "treasury", label: "Treasury", note: "1% tax on items entering the pool" },
  { key: "destroyed", label: "Destroyed", note: "worn out or trader-bound" },
];

/**
 * Public /economy (critique cut 11: numbers only). Server-rendered straight from the DB with the
 * same query as GET /api/economy/stats, so the page needs no client JS.
 */
export default async function EconomyPage() {
  let stats: EconomyStatsDto | null = null;
  try {
    stats = await getEconomyStats(db);
  } catch (e) {
    console.error("[economy] stats failed", e);
  }

  return (
    <div className="min-h-[100dvh] bg-[#0b0f14] text-white">
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 py-8 md:px-6 md:py-12">
        <p className="text-xs uppercase tracking-[0.25em] text-white/50">Open books</p>
        <h1 className="toon-text mt-2 text-4xl tracking-wide text-zooa-lime md:text-6xl">Economy</h1>
        <p className="font-body mt-4 max-w-[62ch] text-base leading-relaxed text-white/70">
          Credits (CR) are earned by extracting with junk and spent at the junker and on listing fees; they never convert to
          money. Gear lost in raids is not deleted: it goes to the lost pool and comes back as loot. Market trades between
          players settle in {stats?.currency ?? "the market currency"} with a seller fee.
        </p>

        <HowItWorks currency={stats?.currency ?? "SOL"} />

        {!stats ? (
          <div className="toon-panel font-body mt-8 bg-[#161b28]/95 p-6 text-white/70">Economy data is unavailable right now.</div>
        ) : (
          <>
            <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4" aria-label="Headline numbers">
              <Tile label="CR in circulation" value={fmtCr(stats.credits.circulating)} tone="text-amber-300" />
              <Tile label="Items in circulation" value={num(stats.items.circulating)} />
              <Tile label="Lost pool" value={num(stats.items.poolSize)} tone="text-sky-300" />
              <Tile label="Trades (24 h)" value={num(stats.market.trades24h)} tone="text-zooa-lime" />
            </section>

            <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <Panel title="Credits in / out">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wider text-white/45">
                      <th className="py-2 font-normal">Flow</th>
                      <th className="py-2 text-right font-normal">24 h</th>
                      <th className="py-2 text-right font-normal">All time</th>
                    </tr>
                  </thead>
                  <tbody className="font-body divide-y divide-white/10">
                    {stats.credits.byReason.length === 0 && (
                      <tr>
                        <td colSpan={3} className="py-3 text-white/50">
                          No credit movements yet.
                        </td>
                      </tr>
                    )}
                    {stats.credits.byReason.map((r) => {
                      const meta = REASON[r.reason] ?? { label: r.reason, note: "" };
                      const in24 = r.in24h - r.out24h;
                      const all = r.inAll - r.outAll;
                      return (
                        <tr key={r.reason}>
                          <td className="py-2.5">
                            <span className="text-white">{meta.label}</span>{" "}
                            <span className="text-xs text-white/40">{meta.note}</span>
                          </td>
                          <td className={`py-2.5 text-right tabular-nums ${in24 >= 0 ? "text-zooa-lime" : "text-rose-300"}`}>{signed(in24)}</td>
                          <td className={`py-2.5 text-right tabular-nums ${all >= 0 ? "text-zooa-lime" : "text-rose-300"}`}>{signed(all)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="font-body border-t-2 border-white/20">
                    <tr>
                      <td className="py-2.5 text-white/70">In / out ratio</td>
                      <td className="py-2.5 text-right tabular-nums text-white">{ratio(stats.credits.in24h, stats.credits.out24h)}</td>
                      <td className="py-2.5 text-right tabular-nums text-white">{ratio(stats.credits.inAll, stats.credits.outAll)}</td>
                    </tr>
                  </tfoot>
                </table>
                <p className="font-body mt-3 text-xs text-white/45">
                  Every account also starts with 1 000 CR. Junk payout multiplier today: ×{stats.autosellMult.toFixed(2)} (steered
                  daily to keep the median balance between 2k and 8k CR).
                </p>
              </Panel>

              <Panel title="Items by state">
                <table className="w-full text-sm">
                  <tbody className="font-body divide-y divide-white/10">
                    {STATE.map((s) => (
                      <tr key={s.key}>
                        <td className="py-2.5">
                          <span className="text-white">{s.label}</span>
                          <span className="block text-xs text-white/40">{s.note}</span>
                        </td>
                        <td className="py-2.5 text-right text-lg tabular-nums text-white">{num(stats.items.byState[s.key] ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>

              <Panel title="Market">
                <dl className="font-body grid grid-cols-[1fr_auto_auto] gap-x-6 gap-y-2.5 text-sm">
                  <dt className="text-xs uppercase tracking-wider text-white/45" />
                  <dd className="text-right text-xs uppercase tracking-wider text-white/45">24 h</dd>
                  <dd className="text-right text-xs uppercase tracking-wider text-white/45">All time</dd>
                  <dt className="text-white/70">Trades</dt>
                  <dd className="text-right tabular-nums">{num(stats.market.trades24h)}</dd>
                  <dd className="text-right tabular-nums">{num(stats.market.tradesAll)}</dd>
                  <dt className="text-white/70">Volume</dt>
                  <dd className="text-right tabular-nums">{formatMinor(stats.market.volume24h)}</dd>
                  <dd className="text-right tabular-nums">{formatMinor(stats.market.volumeAll)}</dd>
                  <dt className="text-white/70">Fees collected</dt>
                  <dd className="text-right tabular-nums">{formatMinor(stats.market.fees24h)}</dd>
                  <dd className="text-right tabular-nums">{formatMinor(stats.market.feesAll)}</dd>
                  <dt className="text-white/70">Open lots</dt>
                  <dd className="col-span-2 text-right tabular-nums">{num(stats.market.activeListings)}</dd>
                </dl>
              </Panel>

              <Panel title="Raiders">
                <dl className="font-body grid grid-cols-[1fr_auto] gap-y-2.5 text-sm">
                  <dt className="text-white/70">Registered</dt>
                  <dd className="text-right tabular-nums">{num(stats.players.registered)}</dd>
                  <dt className="text-white/70">Active (24 h)</dt>
                  <dd className="text-right tabular-nums">{num(stats.players.active24h)}</dd>
                  <dt className="text-white/70">Raids started (24 h)</dt>
                  <dd className="text-right tabular-nums">{num(stats.players.raids24h)}</dd>
                  <dt className="text-white/70">Extraction rate (24 h)</dt>
                  <dd className="text-right tabular-nums">
                    {stats.players.extractRate24h === null ? "—" : `${Math.round(stats.players.extractRate24h * 100)}%`}
                  </dd>
                </dl>
              </Panel>
            </div>

            {stats.daily.length > 0 && (
              <Panel title="Daily snapshots" className="mt-6">
                <div className="overflow-x-auto">
                  <table className="font-body w-full min-w-[32rem] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-white/45">
                        <th className="py-2 font-normal">Day</th>
                        {dailyKeys(stats.daily).map((k) => (
                          <th key={k} className="py-2 text-right font-normal">
                            {k.replace(/_/g, " ")}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/10">
                      {stats.daily.map((d) => (
                        <tr key={d.day}>
                          <td className="py-2 tabular-nums text-white/80">{d.day}</td>
                          {dailyKeys(stats!.daily).map((k) => (
                            <td key={k} className="py-2 text-right tabular-nums">
                              {cell(d.data[k])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}
            <p className="font-body mt-6 text-xs text-white/40">Updated {new Date(stats.generatedAt).toUTCString()}.</p>
          </>
        )}
      </main>
    </div>
  );
}

/** The three economy rules and where each currency and item comes from and goes (static, mirrors docs §2 / §21). */
const RULES: Array<{ title: string; body: string }> = [
  {
    title: "The game never pays out",
    body: "Money moves only from player to player (market) and from player to the treasury (fees, treasury sales). There is no payout path from the treasury.",
  },
  {
    title: "Raids never mint valuables",
    body: "New gear enters only through starter kits and treasury sales. Every valuable item in a crate was lost by a player first.",
  },
  {
    title: "Risk drives reward",
    body: "The lost pool releases gear onto the map only up to what the raiders themselves brought in. A lobby of free kits finds junk only.",
  },
];

function flows(currency: string): Array<{ name: string; tone: string; ins: string[]; outs: string[]; note: string }> {
  return [
    {
      name: currency,
      tone: "text-zooa-lime",
      ins: ["Selling gear to other players (minus the 5% fee)"],
      outs: ["Buying gear from players", "Treasury lots and starter kits"],
      note: "Players can earn only what other players pay. The treasury only receives.",
    },
    {
      name: "CR",
      tone: "text-amber-300",
      ins: ["Junk sold at extraction", "Dog tags", "Starting balance"],
      outs: ["Ammo and meds", "Trader gear (bound)", "Market listing fees"],
      note: "Credits never convert to money in either direction and cannot be transferred.",
    },
    {
      name: "Gear",
      tone: "text-sky-300",
      ins: ["Starter kits", "Treasury sales", "The lost pool (recycled, never new)"],
      outs: ["Breaks on death and wears out", "1% of everything lost goes to the treasury"],
      note: "Trader gear bought for CR is bound: playable, never sellable, destroyed when lost.",
    },
  ];
}

function HowItWorks({ currency }: { currency: string }) {
  return (
    <section className="mt-8" aria-label="How the economy works">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {RULES.map((r, i) => (
          <div key={r.title} className="toon-panel bg-[#161b28]/95 p-5">
            <p className="text-[0.65rem] uppercase tracking-[0.2em] text-white/50">Rule {i + 1}</p>
            <h2 className="toon-text-thin mt-2 text-xl tracking-wide text-white">{r.title}</h2>
            <p className="font-body mt-2 text-sm leading-relaxed text-white/65">{r.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        {flows(currency).map((f) => (
          <div key={f.name} className="toon-panel bg-[#161b28]/95 p-5">
            <h3 className={`toon-text-thin text-2xl tracking-wide ${f.tone}`}>{f.name}</h3>
            <div className="font-body mt-3 grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs uppercase tracking-wider text-white/45">Comes from</p>
                <ul className="mt-1.5 space-y-1 text-white/80">
                  {f.ins.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-white/45">Goes to</p>
                <ul className="mt-1.5 space-y-1 text-white/80">
                  {f.outs.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="font-body mt-3 border-t border-white/10 pt-3 text-xs text-white/50">{f.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Tile({ label, value, tone = "text-white" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="toon-panel bg-[#161b28]/95 p-4 md:p-5">
      <p className="text-[0.65rem] uppercase tracking-[0.2em] text-white/50">{label}</p>
      <p className={`toon-text-thin mt-2 truncate text-2xl tabular-nums tracking-wide md:text-3xl ${tone}`}>{value}</p>
    </div>
  );
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`toon-panel bg-[#161b28]/95 p-5 ${className}`}>
      <h2 className="toon-text-thin text-2xl tracking-wide text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function num(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function signed(n: number): string {
  return n === 0 ? "0" : `${n > 0 ? "+" : "−"}${num(Math.abs(n))}`;
}

function ratio(a: number, b: number): string {
  return b > 0 ? (a / b).toFixed(2) : a > 0 ? "∞" : "—";
}

/** Numeric columns present in the snapshots (economy_daily.data is free-form JSON). */
function dailyKeys(rows: EconomyStatsDto["daily"]): string[] {
  const keys = new Set<string>();
  for (const r of rows) for (const [k, v] of Object.entries(r.data)) if (typeof v === "number" || typeof v === "string") keys.add(k);
  return [...keys].slice(0, 8);
}

function cell(v: unknown): string {
  if (typeof v === "number") return Number.isInteger(v) ? num(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  return "—";
}
