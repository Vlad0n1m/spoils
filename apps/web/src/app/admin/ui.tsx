/**
 * Small server-rendered building blocks of /admin: panels, tiles and plain SVG / CSS charts (no chart
 * library, no client JS; the browser's native <title> tooltip shows exact numbers on hover).
 */

export function Panel({ title, children, className = "", aside }: { title: string; children: React.ReactNode; className?: string; aside?: React.ReactNode }) {
  return (
    <section className={`rounded-xl border border-white/10 bg-[#141925] p-4 md:p-5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-bold text-white">{title}</h2>
        {aside ? <div className="text-xs text-white/45">{aside}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function Tile({ label, value, sub, tone = "text-white" }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#141925] p-3 md:p-4">
      <p className="text-[0.7rem] uppercase tracking-wider text-white/50">{label}</p>
      <p className={`mt-2 truncate text-2xl font-bold tabular-nums ${tone}`}>{value}</p>
      {sub ? <p className="mt-1.5 truncate text-xs leading-snug text-white/50">{sub}</p> : null}
    </div>
  );
}

export interface ChartSeries {
  label: string;
  color: string;
  /** One value per day, same order as `days`. */
  values: number[];
}

/** "2026-10-04" → "04.10". */
export const shortDay = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

/**
 * Per-day bars: `stack` piles the series into one bar per day, `group` puts them side by side. The
 * last day is today (still running) and is drawn lighter. `fmt` formats the labels and tooltips.
 */
export function DayBars({
  days,
  series,
  mode = "stack",
  fmt = (n: number) => n.toLocaleString("ru-RU"),
  title,
}: {
  days: string[];
  series: ChartSeries[];
  mode?: "stack" | "group";
  fmt?: (n: number) => string;
  title: string;
}) {
  const W = 360;
  const H = 150;
  const top = 16;
  const bottom = 22;
  const plotH = H - top - bottom;
  const slot = W / Math.max(1, days.length);
  const barW = Math.min(34, slot * 0.62);
  const totals = days.map((_, i) => series.reduce((s, x) => s + Math.max(0, x.values[i] ?? 0), 0));
  const peak = mode === "stack" ? Math.max(1, ...totals) : Math.max(1, ...series.flatMap((x) => x.values.map((v) => Math.max(0, v))));
  const scale = (v: number) => (Math.max(0, v) / peak) * plotH;
  const last = days.length - 1;

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={title}>
        <line x1={0} x2={W} y1={top + plotH + 0.5} y2={top + plotH + 0.5} stroke="rgba(255,255,255,0.18)" />
        {days.map((day, i) => {
          const cx = slot * i + slot / 2;
          const faded = i === last ? 0.55 : 1;
          if (mode === "stack") {
            let y = top + plotH;
            const parts = series.map((s) => {
              const h = scale(s.values[i] ?? 0);
              y -= h;
              return h > 0 ? (
                <rect key={s.label} x={cx - barW / 2} y={y} width={barW} height={h} fill={s.color} opacity={faded}>
                  <title>{`${shortDay(day)} · ${s.label}: ${fmt(s.values[i] ?? 0)}`}</title>
                </rect>
              ) : null;
            });
            return (
              <g key={day}>
                {parts}
                <text x={cx} y={top + plotH - scale(totals[i]!) - 4} textAnchor="middle" fontSize="10" fill="rgba(255,255,255,0.75)">
                  {totals[i] ? fmt(totals[i]!) : ""}
                </text>
                <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill={i === last ? "#CCFF00" : "rgba(255,255,255,0.5)"}>
                  {i === last ? "сегодня" : shortDay(day)}
                </text>
              </g>
            );
          }
          const w = barW / Math.max(1, series.length);
          return (
            <g key={day}>
              {series.map((s, k) => {
                const v = s.values[i] ?? 0;
                const h = scale(v);
                const x = cx - barW / 2 + k * w;
                return (
                  <g key={s.label}>
                    <rect x={x + 0.5} y={top + plotH - h} width={Math.max(1, w - 1)} height={h} fill={s.color} opacity={faded}>
                      <title>{`${shortDay(day)} · ${s.label}: ${fmt(v)}`}</title>
                    </rect>
                  </g>
                );
              })}
              <text x={cx} y={H - 6} textAnchor="middle" fontSize="10" fill={i === last ? "#CCFF00" : "rgba(255,255,255,0.5)"}>
                {i === last ? "сегодня" : shortDay(day)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-white/65">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}: <span className="tabular-nums text-white/85">{fmt(s.values.reduce((a, b) => a + b, 0))}</span>
          </span>
        ))}
        <span className="text-white/40">(за 7 дней)</span>
      </figcaption>
    </figure>
  );
}

/** Horizontal CSS bars: label, bar, value. */
export function HBars({ rows, color = "#38bdf8" }: { rows: Array<{ label: string; value: number; note?: string }>; color?: string }) {
  const peak = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[9rem_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate text-white/75" title={r.note}>
            {r.label}
          </span>
          <span className="h-2.5 overflow-hidden rounded-full bg-white/[0.06]">
            <span className="block h-full rounded-full" style={{ width: `${(Math.max(0, r.value) / peak) * 100}%`, background: color }} />
          </span>
          <span className="tabular-nums text-white/90">{r.value.toLocaleString("ru-RU")}</span>
        </li>
      ))}
    </ul>
  );
}

/** "2026-10-04 08:27 UTC" (UTC on purpose: identical on the server and in the browser). */
export function utcText(ms: number | null | undefined): string {
  if (!ms) return "—";
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
