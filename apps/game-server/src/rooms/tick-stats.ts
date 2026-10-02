/**
 * Per-room tick timing (opt-in with BATTLE_PERF_LOG=1): the sim step and the whole tick (step + views
 * + patch + ev batches) are sampled every tick and summarised once per window, so a live raid can be
 * checked against the perf memo's per-tick budget without a profiler.
 */
export interface TickSummary {
  ticks: number;
  stepAvg: number;
  stepP95: number;
  tickAvg: number;
  tickP95: number;
  tickMax: number;
}

export class TickStats {
  private step: number[] = [];
  private tick: number[] = [];

  add(stepMs: number, tickMs: number): void {
    this.step.push(stepMs);
    this.tick.push(tickMs);
  }

  get size(): number {
    return this.tick.length;
  }

  /** Summary of the samples so far, then starts a new window. null when empty. */
  flush(): TickSummary | null {
    if (!this.tick.length) return null;
    const out: TickSummary = {
      ticks: this.tick.length,
      stepAvg: avg(this.step),
      stepP95: pct(this.step, 0.95),
      tickAvg: avg(this.tick),
      tickP95: pct(this.tick, 0.95),
      tickMax: Math.max(...this.tick),
    };
    this.step = [];
    this.tick = [];
    return out;
  }
}

export function perfLogEnabled(): boolean {
  return process.env.BATTLE_PERF_LOG === "1";
}

export function fmtTickSummary(s: TickSummary): string {
  const f = (n: number) => n.toFixed(2);
  return `${s.ticks} ticks: step avg ${f(s.stepAvg)} p95 ${f(s.stepP95)} ms; tick avg ${f(s.tickAvg)} p95 ${f(s.tickP95)} max ${f(s.tickMax)} ms`;
}

function avg(a: readonly number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

function pct(a: readonly number[], q: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}
