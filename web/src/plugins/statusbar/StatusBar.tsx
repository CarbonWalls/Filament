import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { WorkspaceApi } from "../../core/types";
import { registry } from "../../core/registry";
import { fmtSize } from "../../core/viewkit";
import { metrics } from "../../core/metrics";
import { settings } from "../../core/settings";

/**
 * Status bar — a plugin, in the `status` chrome slot.
 *
 * Also hosts the live perf readout (rows/s, cache-hit rate) because that is the
 * number the whole design is betting on: if the hit rate is not above 80%,
 * prefetch is not doing its job.
 */
export default function StatusBar(props: { workspace: WorkspaceApi }) {
  const [tick, setTick] = createSignal(0);
  onMount(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    onCleanup(() => clearInterval(id));
  });

  const pane = createMemo(() => {
    tick();
    return props.workspace.focused();
  });

  const stats = createMemo(() => {
    tick();
    const p = pane();
    if (!p) return { count: 0, selected: 0, size: 0, dirs: 0, files: 0 };
    const entries = p.entries();
    return {
      count: entries.length,
      selected: p.selection().length,
      size: entries.reduce((a, e) => a + (e.kind === 1 ? 0 : e.size), 0),
      dirs: entries.filter((e) => e.kind === 1).length,
      files: entries.filter((e) => e.kind !== 1).length,
    };
  });

  const snap = createMemo(() => {
    tick();
    return metrics.snapshot();
  });

  return (
    <>
      <span class="stat optional" title="items in this folder">
        {stats().count.toLocaleString()} items
        <span class="dim">· {stats().dirs} dirs · {fmtSize(stats().size)}</span>
      </span>
      <Show when={stats().selected}>
        <span class="stat hot">{stats().selected} selected</span>
      </Show>
      <span class="grow" />
      <For each={[...(registry.statusItems.values())].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))}>
        {(item) => <StatusPlugin load={item.component} workspace={props.workspace} />}
      </For>
      <Show when={pane()?.path()}>
        <span class="stat path mono dim" title="focused pane path" style={{ "max-width": "34ch", overflow: "hidden", "text-overflow": "ellipsis" }}>
          {pane()!.path()}
        </span>
      </Show>
      <Show when={settings.viewTransitions && snap()["list.ttfb.p50"]}>
        <span class="stat optional" title={`p50 time-to-first-row: ${snap()["list.ttfb.p50"]?.toFixed(1)} ms`}>
          ttf {Math.round(snap()["list.ttfb.p50"] ?? 0)}ms
        </span>
      </Show>
      <PerfChip snap={snap} />
    </>
  );
}

function StatusPlugin(props: { load: () => Promise<{ default: any }>; workspace: WorkspaceApi }) {
  const [Comp, setComp] = createSignal<any>(null);
  void props.load().then((m) => setComp(() => m.default));
  return (
    <Show when={Comp()}>
      <Dynamic component={Comp()} workspace={props.workspace} />
    </Show>
  );
}

function PerfChip(props: { snap: () => Record<string, number> }) {
  const hits = () => props.snap()["prefetch.hit"] ?? 0;
  const miss = () => props.snap()["prefetch.miss"] ?? 0;
  const rate = () => {
    const t = hits() + miss();
    return t ? hits() / t : 0;
  };
  return (
    <Show when={hits() + miss() > 0}>
      <span class="stat optional" title="prefetch hit rate (navigations served from cache)">
        hit <b style={{ color: rate() >= 0.8 ? "var(--good)" : rate() >= 0.5 ? "var(--warn)" : "var(--danger)" }}>{Math.round(rate() * 100)}%</b>
      </span>
    </Show>
  );
}
