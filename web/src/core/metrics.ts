import { createSignal } from "solid-js";

/**
 * Counters for the things the whole design is betting on: cache-hit rate,
 * time-to-first-row, listing latency. Surfaced by the `perf` plugin and
 * readable from the console as `__filament.metrics.snapshot()`.
 */
const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();
const [tick, setTick] = createSignal(0);


export const metrics = {
  record(key: string, value: number) {
    counters.set(key, (counters.get(key) ?? 0) + value);
    setTick((t) => t + 1);
  },
  push(key: string, value: number) {
    const arr = histograms.get(key) ?? [];
    arr.push(value);
    if (arr.length > 512) arr.shift();
    histograms.set(key, arr);
    setTick((t) => t + 1);
  },
  signal: () => tick(),
  /** The most recent `n` samples of a histogram — used by the HUD sparkline. */
  series(key: string, n = 40): number[] {
    return (histograms.get(key) ?? []).slice(-n);
  },
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [k, v] of counters) out[k] = v;
    for (const [k, arr] of histograms) {
      if (!arr.length) continue;
      const sorted = [...arr].sort((a, b) => a - b);
      out[`${k}.p50`] = sorted[Math.floor(sorted.length * 0.5)];
      out[`${k}.p90`] = sorted[Math.floor(sorted.length * 0.9)];
      out[`${k}.max`] = sorted[sorted.length - 1];
      out[`${k}.n`] = arr.length;
    }
    const hits = counters.get("prefetch.hit") ?? 0;
    const miss = counters.get("prefetch.miss") ?? 0;
    const total = hits + miss;
    if (total) out["prefetch.hitRate"] = +(hits / total).toFixed(4);
    return out;
  },
  reset() {
    counters.clear();
    histograms.clear();
    setTick((t) => t + 1);
  },
};

export type Metrics = typeof metrics;

/** The listing store pushes its measurements through this hook. */
export function bindMetrics(fn: (key: string, value: number) => void) {
  pushHook = fn;
}
let pushHook: (key: string, value: number) => void = () => {};
export function recordPush(key: string, value: number) {
  pushHook(key, value);
}
