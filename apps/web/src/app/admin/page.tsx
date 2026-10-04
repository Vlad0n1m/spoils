import Link from "next/link";
import { db } from "@/db/client";
import type { InvariantRunRow } from "@/db/schema";
import { latestInvariantRuns } from "@/lib/admin/invariants";
import { adminMetrics } from "@/lib/admin/metrics";
import { requireAdminPage } from "@/lib/admin/server";
import type { AdminKpi, AdminMetrics, KpiStatus } from "@/lib/admin/types";
import { formatMinor } from "@/lib/market/config";
import { DayBars, HBars, Panel, Tile, shortDay, utcText } from "./ui";

export const dynamic = "force-dynamic";

const CR_REASON: Record<string, string> = {
  autosell: "Автопродажа хлама",
  giveaway: "Стартовые наборы",
  consumables: "Барахольщик: патроны и аптечки",
  bound: "Торговец: привязанное снаряжение",
  listing_fee: "Сборы за лоты",
  admin: "Правки админа",
};

const HOUSE_REASON: Record<string, string> = {
  fee: "Комиссия рынка",
  treasury_sale: "Продажа лотов казны",
  kit_sale: "Продажа наборов",
};

const ITEM_STATE: Record<string, string> = {
  in_stash: "На складах",
  listed: "Выставлены",
  in_raid: "В рейдах",
  lost_pool: "Пул потерь",
  treasury: "Казна",
  destroyed: "Уничтожены",
};

const STATUS: Record<KpiStatus, { text: string; cls: string }> = {
  ok: { text: "норма", cls: "bg-emerald-400/15 text-emerald-300" },
  warn: { text: "вне нормы", cls: "bg-amber-400/15 text-amber-300" },
  alarm: { text: "тревога", cls: "bg-red-500/20 text-red-300" },
  none: { text: "нет данных", cls: "bg-white/[0.06] text-white/50" },
};

const n = (v: number) => Math.round(v).toLocaleString("ru-RU");

function plural(k: number, one: string, few: string, many: string): string {
  const a = k % 100;
  const b = k % 10;
  if (a >= 11 && a <= 14) return many;
  return b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}

/** /admin: online, today, the 7-day series, CR flows, items by state, treasury income, ALPHA_PLAN §4 KPIs. */
export default async function AdminMetricsPage() {
  await requireAdminPage();
  let m: AdminMetrics | null = null;
  try {
    m = await adminMetrics(db);
  } catch (e) {
    console.error("[admin] metrics failed", e);
  }
  let inv: InvariantRunRow | null | undefined;
  try {
    inv = (await latestInvariantRuns(db, 1))[0] ?? null;
  } catch (e) {
    console.error("[admin] invariant runs failed", e);
  }
  if (!m) {
    return <p className="rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-sm text-red-200">Метрики не загрузились, см. логи сервера.</p>;
  }

  const days = m.days.map((d) => d.day);
  const today = m.days[m.days.length - 1]!;
  const todayExits = today.exits.extract + today.exits.dead + today.exits.mia + today.exits.timeout;
  const crInToday = today.crIn;
  const crOutToday = today.crOut;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h1 className="text-2xl font-bold md:text-3xl">Метрики</h1>
        <p className="text-xs text-white/45">
          Окно: 7 UTC-дней с {shortDay(days[0]!)} · обновлено {utcText(m.generatedAt)} · JSON: <code>/api/admin/metrics</code>
        </p>
      </div>

      <InvariantBanner run={inv} />

      <section aria-label="Сейчас" className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="На карте сейчас"
          value={n(m.online.total)}
          sub={`${n(m.online.registered)} зарег. · ${n(m.online.guests)} гостей`}
          tone="text-zooa-lime"
        />
        <Tile
          label={`Карта №${m.online.mapNumber}`}
          value={m.online.shards.length ? `${m.online.shards.length} ${plural(m.online.shards.length, "шард", "шарда", "шардов")}` : "не открыта"}
          sub={m.online.shards.map((s) => `#${s.shard}: ${s.registered + s.guests}`).join(" · ") || `цикл ${m.online.cycle}`}
        />
        <Tile
          label="Зависшие входы"
          value={n(m.online.staleActive)}
          sub="активные входы прошлых карт (крон void-raids)"
          tone={m.online.staleActive > 0 ? "text-amber-300" : "text-white"}
        />
        <Tile label="Вещей в базе" value={n(m.items.total)} sub={`пул ${n(m.items.byState.find((s) => s.state === "lost_pool")?.n ?? 0)}`} />
      </section>

      <section aria-label="Сегодня" className="grid grid-cols-2 gap-3 md:grid-cols-6">
        <Tile label="Входы сегодня" value={n(today.entries)} sub={`гостей ${n(today.entriesGuest)}`} />
        <Tile label="Выходы с картой" value={n(today.exits.extract)} sub={`из ${n(todayExits)} завершённых`} tone="text-zooa-lime" />
        <Tile label="Смерти" value={n(today.deaths)} sub={`MIA ${n(today.exits.mia)}`} tone="text-red-300" />
        <Tile label="PvP-убийства" value={n(today.pvpKills)} sub={`ранговых ${n(today.pvpRanked)}`} />
        <Tile label="CR приток / сток" value={`${n(crInToday)} / ${n(crOutToday)}`} sub="сегодня" tone="text-amber-300" />
        <Tile label="Доход казны" value={formatMinor(today.houseMinor)} sub="сегодня" tone="text-accent-300" />
      </section>

      <Panel title="KPI альфы" aside="ALPHA_PLAN §4 · доп. из GAME_DESIGN §22">
        <KpiTable kpis={m.kpis} />
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Входы по дням">
          <DayBars
            title="Входы по дням"
            days={days}
            series={[
              { label: "Зарегистрированные", color: "#38bdf8", values: m.days.map((d) => d.entries - d.entriesGuest) },
              { label: "Гости", color: "#64748b", values: m.days.map((d) => d.entriesGuest) },
            ]}
          />
        </Panel>
        <Panel title="Исходы по дням">
          <DayBars
            title="Исходы по дням"
            days={days}
            series={[
              { label: "Вышли", color: "#CCFF00", values: m.days.map((d) => d.exits.extract) },
              { label: "Погибли", color: "#f87171", values: m.days.map((d) => d.exits.dead) },
              { label: "MIA", color: "#fbbf24", values: m.days.map((d) => d.exits.mia) },
              ...(m.days.some((d) => d.exits.timeout) ? [{ label: "Таймаут (старые)", color: "#94a3b8", values: m.days.map((d) => d.exits.timeout) }] : []),
            ]}
          />
        </Panel>
        <Panel title="Смерти и PvP-убийства">
          <DayBars
            title="Смерти и PvP-убийства"
            mode="group"
            days={days}
            series={[
              { label: "Смерти", color: "#f87171", values: m.days.map((d) => d.deaths) },
              { label: "PvP-убийства", color: "#c8a3ff", values: m.days.map((d) => d.pvpKills) },
              { label: "из них ранговые", color: "#9945ff", values: m.days.map((d) => d.pvpRanked) },
            ]}
          />
        </Panel>
        <Panel title="CR: приток и сток">
          <DayBars
            title="CR: приток и сток"
            mode="group"
            days={days}
            series={[
              { label: "Приток", color: "#34d399", values: m.days.map((d) => d.crIn) },
              { label: "Сток", color: "#f472b6", values: m.days.map((d) => d.crOut) },
            ]}
          />
        </Panel>
        <Panel title={`Доход казны, ${m.house.currency}`} className="lg:col-span-2">
          <DayBars
            title="Доход казны по дням"
            days={days}
            fmt={(v) => formatMinor(Math.round(v))}
            series={[{ label: "Казна (house)", color: "#c8a3ff", values: m.days.map((d) => Number(d.houseMinor)) }]}
          />
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="CR по причинам" aside="credit_ledger">
          {m.credits.byReason.length === 0 ? (
            <p className="text-sm text-white/50">За 7 дней движений CR не было.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[26rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-white/45">
                    <th className="py-1.5 font-normal">Причина</th>
                    <th className="py-1.5 text-right font-normal">Сегодня +/−</th>
                    <th className="py-1.5 text-right font-normal">7 дней +/−</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {m.credits.byReason.map((r) => (
                    <tr key={r.reason}>
                      <td className="py-1.5 pr-2">
                        {CR_REASON[r.reason] ?? r.reason} <span className="text-xs text-white/35">{r.reason}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <span className="text-emerald-300">+{n(r.inToday)}</span> / <span className="text-pink-300">−{n(r.outToday)}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        <span className="text-emerald-300">+{n(r.in7d)}</span> / <span className="text-pink-300">−{n(r.out7d)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-white/25">
                  <tr>
                    <td className="py-1.5 font-semibold">Итого за 7 дней</td>
                    <td />
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      +{n(m.credits.in7d)} / −{n(m.credits.out7d)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Вещи по состояниям" aside={`всего ${n(m.items.total)}`}>
          <HBars rows={m.items.byState.map((s) => ({ label: ITEM_STATE[s.state] ?? s.state, value: s.n, note: s.state }))} />
        </Panel>

        <Panel title={`Казна по источникам, ${m.house.currency}`} aside="money_ledger, счёт house" className="lg:col-span-2">
          {m.house.byReason.length === 0 ? (
            <p className="text-sm text-white/50">Доходов казны пока нет.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[30rem] text-sm">
                <thead>
                  <tr className="text-left text-xs text-white/45">
                    <th className="py-1.5 font-normal">Источник</th>
                    <th className="py-1.5 text-right font-normal">Сегодня</th>
                    <th className="py-1.5 text-right font-normal">7 дней</th>
                    <th className="py-1.5 text-right font-normal">Всё время</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {m.house.byReason.map((r) => (
                    <tr key={r.reason}>
                      <td className="py-1.5 pr-2">
                        {HOUSE_REASON[r.reason] ?? r.reason} <span className="text-xs text-white/35">{r.reason}</span>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatMinor(r.today)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMinor(r.d7)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatMinor(r.all)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-white/25">
                  <tr>
                    <td className="py-1.5 font-semibold">Итого</td>
                    <td />
                    <td className="py-1.5 text-right font-semibold tabular-nums">{formatMinor(m.house.d7)}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">{formatMinor(m.house.all)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="mt-3 text-xs leading-relaxed text-white/45">
            Суммы в минорных единицах рынка (balance_cents), показаны тем же форматом, что и на рынке. Игра никому не платит:
            это только поступления на счёт house.
          </p>
        </Panel>
      </div>
    </div>
  );
}

function KpiTable({ kpis }: { kpis: AdminKpi[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="text-left text-xs text-white/45">
            <th className="py-1.5 font-normal">Метрика</th>
            <th className="py-1.5 text-right font-normal">Сейчас</th>
            <th className="py-1.5 pl-4 font-normal">Норма</th>
            <th className="py-1.5 font-normal">Тревога</th>
            <th className="py-1.5 font-normal">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10">
          {kpis.map((k) => {
            const s = STATUS[k.status];
            return (
              <tr key={k.id} className="align-top">
                <td className="py-2 pr-2">
                  <span className="font-semibold">{k.label}</span>
                  {k.source === "§22" ? <span className="ml-1.5 text-[0.65rem] text-white/35">§22</span> : null}
                  <p className="mt-1 max-w-[46ch] text-xs leading-snug text-white/45">{k.note}</p>
                </td>
                <td className="py-2 text-right text-base font-bold tabular-nums">{k.value ?? <span className="text-sm font-normal text-white/40">нет данных</span>}</td>
                <td className="py-2 pl-4 tabular-nums text-white/70">{k.norm}</td>
                <td className="py-2 tabular-nums text-white/70">{k.alarm}</td>
                <td className="py-2">
                  <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${s.cls}`}>{s.text}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Latest nightly invariant check (B6), linking to /admin/invariants. */
function InvariantBanner({ run }: { run: InvariantRunRow | null | undefined }) {
  const tone =
    run === undefined || run === null
      ? "border-white/10 bg-[#141925] text-white/70"
      : run.ok
        ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-100"
        : "border-red-400/40 bg-red-500/15 text-red-100";
  const text =
    run === undefined
      ? "Сверка инвариантов: не загрузилась"
      : run === null
        ? "Сверка инвариантов: прогонов ещё не было"
        : run.ok
          ? `Сверка инвариантов: всё сходится · ${utcText(run.startedAt.getTime())}`
          : `Сверка инвариантов: не сошлось ${run.failed} (${run.checks
              .filter((c) => c.status !== "ok")
              .map((c) => c.key)
              .join(", ")}) · ${utcText(run.startedAt.getTime())}`;
  return (
    <Link href="/admin/invariants" className={`flex min-h-[44px] items-center justify-between gap-3 rounded-xl border px-4 py-2 text-sm font-semibold ${tone}`}>
      <span>{text}</span>
      <span aria-hidden className="opacity-60">→</span>
    </Link>
  );
}
