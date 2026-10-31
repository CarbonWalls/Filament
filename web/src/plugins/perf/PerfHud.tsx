import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { WorkspaceApi } from "../../core/types";
import { metrics } from "../../core/metrics";
import { registry } from "../../core/registry";
import { Icon } from "../../icons";
import { LATENCY } from "./table";

/**
 * Perf HUD — the numbers the design is judged on, live.
 *
 * Rendered in a floating panel (and as status-bar chips) so the claims in the
 * README can be checked against a running app rather than believed.
 */
export default function PerfHud(_props: { workspace: WorkspaceApi }) {
  const [open, setOpen] = createSignal(false);
  const [tick, setTick] = createSignal(0);
  const [spark, setSpark] = createSignal<number[]>([]);

  onMount(() => {
    // The panel must be *live*: bump the tick signal so `snap()` recomputes.
    // (Reading it instead of setting it leaves the HUD frozen on its mount-time
    // snapshot, which is how it once showed a proud 0% hit rate.)
    const id = setInterval(() => {
      setTick((t) => t + 1);
      setSpark(metrics.series("list.ttfb", 40));
    }, 1000);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    });
  });

  const snap = createMemo(() => {
    tick();
    return metrics.snapshot();
  });

  const bar = (key: string, budget: number, label: string) => {
    const v = snap()[key] ?? 0;
    const pct = Math.min(100, (v / budget) * 100);
    const ok = v <= budget;
    return { v, pct, ok, label, budget };
  };

  const rows = createMemo(() => [
    bar("list.ttfb.p50", 16, "TTFB p50 (ms) · budget 16"),
    bar("list.ttfb.p90", 50, "TTFB p90 (ms) · budget 50"),
    bar("list.scan.p50", 200, "Scan p50 (ms) · budget 200"),
    bar("plugin.loadMs.p90", 40, "Plugin load p90 (ms)"),
    bar("preview.ms.p50", 120, "Preview p50 (ms)"),
  ]);

  return (
    <>
      <Show when={open()}>
        <Portal>
          <div class="perf-hud">
            <div class="perf-head">
              <Icon name="gauge" size={14} />
              <b>Latency</b>
              <span class="grow" />
              <button class="icon-btn" style={{ width: "20px", height: "20px" }} onClick={() => metrics.reset()}>
                <Icon name="refresh" size={12} />
              </button>
              <button class="icon-btn" style={{ width: "20px", height: "20px" }} onClick={() => setOpen(false)}>
                <Icon name="close" size={12} />
              </button>
            </div>

            <div class="perf-grid">
              <For each={rows()}>
                {(r) => (
                  <div class="perf-row">
                    <span class="dim">{r.label}</span>
                    <span class="perf-bar">
                      <i style={{ width: `${r.pct}%`, background: r.ok ? "var(--good)" : "var(--danger)" }} />
                    </span>
                    <b class="mono">{r.v ? r.v.toFixed(1) : "–"}</b>
                  </div>
                )}
              </For>
            </div>

            <div class="perf-grid" style={{ "border-top": "1px solid var(--line-soft)" }}>
              <div class="perf-row">
                <span class="dim">prefetch hit rate</span>
                <span class="perf-bar">
                  <i
                    style={{
                      width: `${Math.round((snap()["prefetch.hitRate"] ?? 0) * 100)}%`,
                      background: (snap()["prefetch.hitRate"] ?? 0) >= 0.8 ? "var(--good)" : "var(--warn)",
                    }}
                  />
                </span>
                <b class="mono">{Math.round((snap()["prefetch.hitRate"] ?? 0) * 100)}%</b>
              </div>
              <div class="perf-row">
                <span class="dim">prefetches issued</span>
                <span class="perf-bar" />
                <b class="mono">{snap()["prefetch.issued"] ?? 0}</b>
              </div>
              <div class="perf-row">
                <span class="dim">navigations</span>
                <span class="perf-bar" />
                <b class="mono">{snap()["nav.count"] ?? 0}</b>
              </div>
              <div class="perf-row">
                <span class="dim">plugins loaded</span>
                <span class="perf-bar" />
                <b class="mono">{registry.loadedList().length}</b>
              </div>
              <div class="perf-row">
                <span class="dim">watch rescans</span>
                <span class="perf-bar" />
                <b class="mono">{snap()["watch.rescan"] ?? 0}</b>
              </div>
            </div>

            <div class="perf-foot">
              <svg width="100%" height="26" viewBox="0 0 320 26" preserveAspectRatio="none">
                <For each={spark()}>
                  {(v, i) => {
                    const max = Math.max(8, ...spark());
                    const h = Math.max(1, (v / max) * 22);
                    return <rect x={i() * 8} y={24 - h} width="6" height={h} fill={v <= 16 ? "var(--good)" : v <= 50 ? "var(--warn)" : "var(--danger)"} />;
                  }}
                </For>
              </svg>
              <div class="dim" style={{ "font-size": "10.5px" }}>
                time to first row, one bar per navigation burst
              </div>
            </div>

            <div class="perf-foot dim" style={{ "font-size": "10.5px", "border-top": "1px solid var(--line-soft)" }}>
              {LATENCY.join(" · ")}
            </div>
          </div>
        </Portal>
      </Show>
      <button class="stat" style={{ background: "none", border: 0, cursor: "pointer", color: "inherit" }} onClick={() => setOpen((v) => !v)} title="Latency HUD (Ctrl/Cmd+Shift+D)">
        hud
      </button>
    </>
  );
}
