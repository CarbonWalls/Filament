import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Entry, PaneApi } from "../../core/types";
import { listingsRev, listingFor, warm } from "../../core/listings";
import { registry, transport } from "../../core/registry";
import { Icon, iconFor } from "../../icons";
import { fmtSize, hoverPrefetch, isMedia } from "../../core/viewkit";
import { join } from "../../core/workspace";
import { openMenu, toast } from "../../ui/overlays";
import { settings } from "../../core/settings";
import { latencyTier, slideClass, useGrace, useTicker } from "../../core/anim";
import { metrics } from "../../core/metrics";

/**
 * Grid view — thumbnails, viewport prefetch, same two-phase contract as the
 * list view. Thumbnails arrive lazily from the daemon's content-addressed
 * cache, so scrolling a photo folder never waits for image decoding.
 */
export default function GridView(props: { pane: PaneApi; workspace: any }) {
  const pane = props.pane;
  let scroller: HTMLDivElement | undefined;
  const hidden = () => pane.showHidden();
  const path = () => pane.path();

  const listing = createMemo(() => {
    listingsRev();
    return listingFor(path(), hidden())();
  });
  const entries = createMemo(() => {
    listingsRev();
    return props.workspace.entriesFor(pane.id);
  });

  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewW, setViewW] = createSignal(900);
  const [viewH, setViewH] = createSignal(600);
  const selection = createMemo(() => new Set(pane.selection()));
  const [cursor, setCursor] = createSignal(0);

  const minCell = () => (settings.density === "compact" ? 108 : 132);
  // Cap the column count so cells *grow* on a wide pane instead of shrinking
  // into a strip of postage stamps.
  const MAX_COLS = 7;
  const cols = createMemo(() =>
    Math.max(1, Math.min(MAX_COLS, Math.floor((viewW() - 20) / minCell())))
  );
  const cellW = createMemo(() => Math.max(72, (viewW() - 20) / cols()));
  const cellH = createMemo(() => Math.round(Math.min(cellW() * 0.86, 300)));
  const rows = createMemo(() => Math.ceil(entries().length / cols()));

  const range = createMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop() / cellH()) - 2);
    const visible = Math.ceil(viewH() / cellH()) + 4;
    return { first, last: Math.min(rows(), first + visible) };
  });

  const grace = useGrace(40);
  createEffect(() => {
    path();
    grace.reset();
  });
  const waiting = () => entries().length === 0 && listing().phase !== "done" && listing().phase !== "error";
  const showSkeleton = () => waiting() && grace.elapsed();
  const tick = useTicker(80);
  const tier = createMemo(() => {
    const l = listing();
    if (l.ttfbMs === undefined && waiting()) {
      tick();
      return latencyTier(performance.now() - l.startedAt);
    }
    return latencyTier(l.ttfbMs ?? 0);
  });
  const swapClass = createMemo(() => {
    if (tier() === "instant") return "";
    return slideClass(props.workspace.paneDirection(pane.id)) || "swap-fade";
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (!scroller) return;
      setViewW(scroller.clientWidth);
      setViewH(scroller.clientHeight);
    });
    if (scroller) {
      ro.observe(scroller);
      setViewW(scroller.clientWidth);
      setViewH(scroller.clientHeight);
    }
    onCleanup(() => ro.disconnect());
  });

  // Prefetch every folder that scrolls into view — this is where the 80% hit
  // rate actually comes from on a photo/asset drive.
  let io: IntersectionObserver | undefined;
  onMount(() => {
    io = new IntersectionObserver(
      (obs) => {
        for (const o of obs) {
          if (!o.isIntersecting) continue;
          const p = (o.target as HTMLElement).dataset.path;
          if (p) warm(p, hidden());
        }
      },
      { root: scroller, rootMargin: "200px" }
    );
    onCleanup(() => io?.disconnect());
  });

  const hover = hoverPrefetch(pane);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);

  const open = (entry: Entry) => {
    if (entry.kind === 1 || entry.kind === 3) {
      props.workspace.navigate(pane.id, join(path(), entry.name), { direction: 1 });
    } else {
      registry.commands.get("open.preview")?.run(null as any);
    }
  };

  const onDrop = async (e: DragEvent, entry: Entry) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const raw = e.dataTransfer?.getData("application/x-filament-paths");
    if (!raw) return;
    let paths: string[] = [];
    try {
      paths = JSON.parse(raw);
    } catch {
      return;
    }
    const dest = join(path(), entry.name);
    const op = e.altKey ? "copy" : "move";
    try {
      await transport.request("op", { op, src: paths, dest });
      toast({ title: `${op === "copy" ? "Copied" : "Moved"} ${paths.length} item(s)` });
      props.workspace.invalidatePane(pane.id);
    } catch (err) {
      toast({ title: `${op} failed`, detail: String(err), kind: "error" });
    }
  };

  const contextFor = (entry: Entry) => {
    const p = join(path(), entry.name);
    const sel = selection().size ? pane.selection() : [p];
    const names = new Set(sel.map((x) => x.split("/").pop()));
    return {
      paths: sel,
      entries: entries().filter((x: Entry) => names.has(x.name)),
      focused: { path: p, entry },
      isDir: entry.kind === 1,
      isSingle: sel.length === 1,
      panePath: path(),
    };
  };

  const visible = createMemo(() => entries().slice(range().first * cols(), range().last * cols()));

  return (
    <div style={{ display: "flex", "flex-direction": "column", "min-height": 0, flex: 1 }}>
      <div
        class="grid-wrap"
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => {
          e.preventDefault();
          const items = [...registry.contextMenu.values()];
          openMenu(
            e.clientX,
            e.clientY,
            items.map((i) => ({
              id: i.id,
              label: i.label,
              key: i.key,
              separator: i.separator,
              disabled: i.when ? !i.when({ paths: [], entries: [], isDir: false, isSingle: false, panePath: path() }) : false,
              run: () => i.run({ paths: [], entries: [], isDir: false, isSingle: false, panePath: path() }, pane),
            }))
          );
        }}
      >
        <Show when={showSkeleton()}>
          <div class="grid-inner" style={{ height: `${Math.min(3, rows()) * cellH()}px` }}>
            <For each={Array.from({ length: Math.min(cols() * 3, 24) })}>
              {(_, i) => (
                <div
                  class="cell"
                  classList={{ "skeleton-live": tier() === "shimmer" || tier() === "progress", "skeleton-static": tier() !== "shimmer" && tier() !== "progress" }}
                  style={{
                    left: `${(i() % cols()) * cellW()}px`,
                    top: `${Math.floor(i() / cols()) * cellH()}px`,
                    width: `${cellW() - 10}px`,
                    height: `${cellH() - 10}px`,
                  }}
                >
                  <div class="cell-thumb sk" style={{ width: "100%" }} />
                  <div class="sk sk-name" style={{ width: "70%", margin: "0 auto" }} />
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class={showSkeleton() ? "" : swapClass()} style={{ display: showSkeleton() ? "none" : "block" }}>
          <div class="grid-inner" style={{ height: `${rows() * cellH()}px` }}>
            <For each={visible()}>
              {(entry, i) => {
                const index = () => range().first * cols() + i();
                const p = () => join(path(), entry.name);
                const isDirish = () => entry.kind === 1 || entry.kind === 3;
                return (
                  <div
                    class="cell"
                    classList={{ selected: selection().has(p()), cursor: cursor() === index(), "drop-target": dropTarget() === p() }}
                    style={{
                      left: `${(index() % cols()) * cellW()}px`,
                      top: `${Math.floor(index() / cols()) * cellH()}px`,
                      width: `${cellW() - 10}px`,
                      height: `${cellH() - 10}px`,
                    }}
                    data-key={entry.name}
                    ref={(el) => {
                      if (io && isDirish()) {
                        el.dataset.path = p();
                        io.observe(el);
                      }
                    }}
                    onMouseEnter={() => hover.enter(entry, p())}
                    onMouseLeave={() => hover.leave()}
                    onDragStart={(e) => {
                      e.dataTransfer?.setData("application/x-filament-paths", JSON.stringify(pane.selection().length ? pane.selection() : [p()]));
                      e.dataTransfer!.effectAllowed = "copyMove";
                    }}
                    onDragOver={(e) => {
                      if (isDirish()) {
                        e.preventDefault();
                        setDropTarget(p());
                      }
                    }}
                    onDragLeave={() => dropTarget() === p() && setDropTarget(null)}
                    onDrop={(e) => void onDrop(e, entry)}
                    draggable
                    onClick={(e) => {
                      if (e.shiftKey) pane.setSelection([...pane.selection(), p()]);
                      else if (e.ctrlKey || e.metaKey) {
                        const next = new Set(pane.selection());
                        next.has(p()) ? next.delete(p()) : next.add(p());
                        pane.setSelection([...next]);
                      } else pane.setSelection([p()]);
                      setCursor(index());
                      pane.requestFocus();
                    }}
                    onDblClick={() => open(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!selection().has(p())) pane.setSelection([p()]);
                      const sel = contextFor(entry);
                      openMenu(
                        e.clientX,
                        e.clientY,
                        [...registry.contextMenu.values()].map((i) => ({
                          id: i.id,
                          label: i.label,
                          key: i.key,
                          separator: i.separator,
                          disabled: i.when ? !i.when(sel) : false,
                          run: () => i.run(sel, pane),
                        }))
                      );
                    }}
                    title={`${entry.name} · ${fmtSize(entry.size)}`}
                  >
                    <div class="cell-thumb">
                      <Show when={isMedia(entry)} fallback={<Icon name={iconFor(entry)} size={Math.min(42, cellW() * 0.3)} />}>
                        <img
                          src={`/api/thumb?size=${Math.ceil(cellW() * 2)}&path=${encodeURIComponent(p())}`}
                          loading="lazy"
                          decoding="async"
                          class="thumb-fade"
                          alt=""
                          onError={(e) => {
                            metrics.record("thumb.error", 1);
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </Show>
                    </div>
                    <div class="cell-name">{entry.name}</div>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        <Show when={!waiting() && entries().length === 0}>
          <div class="empty">{pane.filter() ? "nothing matches that filter" : "empty folder"}</div>
        </Show>
      </div>
    </div>
  );
}
