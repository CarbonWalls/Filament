import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Entry, PaneApi } from "../../core/types";
import { listingsRev, listingFor, warm } from "../../core/listings";
import { settings } from "../../core/settings";
import { registry, transport } from "../../core/registry";
import { Icon, iconFor } from "../../icons";
import {
  beginDrag,
  dragPayload,
  fmtDate,
  fmtSize,
  rangeSelection,
  hoverPrefetch,
  splitName,
  viewportObserver,
} from "../../core/viewkit";
import { latencyTier, slideClass, staggerDelay, useGrace, useTicker } from "../../core/anim";
import { join } from "../../core/workspace";
import { openMenu, toast } from "../../ui/overlays";
import { metrics } from "../../core/metrics";

/**
 * List view — a plugin, not part of the shell.
 *
 * Two-phase render: rows come from the listing store, which paints the cached
 * listing on frame 0 and reconciles the streamed scan underneath. The skeleton
 * is held behind a 40 ms grace window so a fast folder shows *nothing*.
 */
export default function ListView(props: { pane: PaneApi; workspace: any }) {
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

  // ---- virtualization ----------------------------------------------------
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  const rowH = () => (settings.density === "compact" ? 26 : 30);
  const overscan = 8;

  const range = createMemo(() => {
    const h = rowH();
    const first = Math.max(0, Math.floor(scrollTop() / h) - overscan);
    const visible = Math.ceil(viewH() / h) + overscan * 2;
    const last = Math.min(entries().length, first + visible);
    return { first, last };
  });
  const windowed = createMemo(() => entries().slice(range().first, range().last));

  const selection = createMemo(() => new Set(pane.selection()));
  const [cursor, setCursor] = createSignal(0);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);

  // ---- latency-mapped transitions ---------------------------------------
  const grace = useGrace(40);
  createEffect(() => {
    path();
    grace.reset();
  });
  const phase = () => listing().phase;
  // While the first frame is still in flight we grade the *wait so far*, so the
  // UI escalates from nothing → shimmer → progress honestly.
  const waiting = () => entries().length === 0 && phase() !== "done" && phase() !== "error";
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
    // <50ms: no animation at all — animating here measures slower AND feels
    // slower. Above that, slide in the direction of travel (the iOS trick).
    if (tier() === "instant") return "";
    return slideClass(props.workspace.paneDirection(pane.id)) || "swap-fade";
  });

  // ---- geometry ----------------------------------------------------------
  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (scroller) setViewH(scroller.clientHeight);
    });
    if (scroller) {
      ro.observe(scroller);
      setViewH(scroller.clientHeight);
    }
    onCleanup(() => ro.disconnect());
  });

  // ---- keyboard ----------------------------------------------------------
  const [anchor, setAnchor] = createSignal(0);

  const move = (delta: number, extend: boolean) => {
    const list = entries();
    if (!list.length) return;
    const from = cursor();
    const next = Math.max(0, Math.min(list.length - 1, from + delta));
    if (!extend) setAnchor(next);
    setCursor(next);
    if (extend) {
      pane.setSelection(rangeSelection(list, anchor(), next, (n) => join(path(), n)));
    } else {
      pane.setSelection([join(path(), list[next].name)]);
    }
    scrollIntoView(next);
    registry.emit("selection", { pane: pane.id, paths: pane.selection() });
  };

  const scrollIntoView = (index: number) => {
    if (!scroller) return;
    const h = rowH();
    const top = index * h;
    const bottom = top + h;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight;
    }
  };

  const activate = (entry: Entry) => {
    if (entry.kind === 1 || entry.kind === 3) {
      props.workspace.navigate(pane.id, join(path(), entry.name), { direction: 1 });
    } else {
      registry.commands.get("open.preview")?.run(null as any);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (renaming()) return;
    const list = entries();
    const combo = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(e.shiftKey ? 1 : 1, e.shiftKey);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(-1, e.shiftKey);
        break;
      case "PageDown":
        e.preventDefault();
        move(Math.floor(viewH() / rowH()) - 1, false);
        break;
      case "PageUp":
        e.preventDefault();
        move(-(Math.floor(viewH() / rowH()) - 1), false);
        break;
      case "Home":
        e.preventDefault();
        setCursor(0);
        if (list[0]) pane.setSelection([join(path(), list[0].name)]);
        scrollIntoView(0);
        break;
      case "End": {
        e.preventDefault();
        const n = list.length - 1;
        setCursor(n);
        if (list[n]) pane.setSelection([join(path(), list[n].name)]);
        scrollIntoView(n);
        break;
      }
      case "Enter": {
        e.preventDefault();
        const sel = pane.selection();
        if (sel.length) {
          const name = sel[sel.length - 1].split("/").pop()!;
          const entry = list.find((x: Entry) => x.name === name);
          if (entry) activate(entry);
        } else if (list[cursor()]) activate(list[cursor()]);
        break;
      }
      case "Backspace":
        e.preventDefault();
        registry.commands.get("nav.up")?.run(null as any);
        break;
      case "F2":
        e.preventDefault();
        if (pane.selection().length === 1) setRenaming(baseName(pane.selection()[0]));
        break;
      case "a":
        if (combo) {
          e.preventDefault();
          pane.setSelection(list.map((x: Entry) => join(path(), x.name)));
        }
        break;
      case "Escape":
        pane.setSelection([]);
        break;
      default:
        // Type-to-select: jump to the first row starting with the typed letter.
        if (e.key.length === 1 && !combo && !e.altKey) {
          const start = cursor() + 1;
          const found = [...list.slice(start), ...list.slice(0, start)].find((x: Entry) =>
            x.name.toLowerCase().startsWith(e.key.toLowerCase())
          );
          if (found) {
            const idx = list.indexOf(found);
            setCursor(idx);
            pane.setSelection([join(path(), found.name)]);
            scrollIntoView(idx);
          }
        }
    }
  };

  // ---- selection ---------------------------------------------------------
  const clickRow = (e: MouseEvent, entry: Entry, index: number) => {
    const p = join(path(), entry.name);
    if (e.shiftKey) {
      pane.setSelection(rangeSelection(entries(), anchor(), index, (n) => join(path(), n)));
    } else if (e.ctrlKey || e.metaKey) {
      setAnchor(index);
      const next = new Set(selection());
      next.has(p) ? next.delete(p) : next.add(p);
      pane.setSelection([...next]);
    } else {
      setAnchor(index);
      pane.setSelection([p]);
    }
    setCursor(index);
    pane.requestFocus();
  };

  const onDblClick = (entry: Entry) => activate(entry);

  const contextFor = (entry?: Entry) => {
    const focusPath = entry ? join(path(), entry.name) : undefined;
    const sel = pane.selection().length ? pane.selection() : focusPath ? [focusPath] : [];
    const names = new Set(sel.map((p: string) => p.split("/").pop()));
    return {
      paths: sel,
      entries: entries().filter((x: Entry) => names.has(x.name)),
      focused: entry ? { path: focusPath!, entry } : undefined,
      isDir: entry?.kind === 1,
      isSingle: sel.length === 1,
      panePath: path(),
    };
  };

  const openContextMenu = (e: MouseEvent, entry?: Entry) => {
    e.preventDefault();
    pane.requestFocus();
    if (entry && !selection().has(join(path(), entry.name))) {
      pane.setSelection([join(path(), entry.name)]);
    }
    const items = [...registry.contextMenu.values()];
    openMenu(
      e.clientX,
      e.clientY,
      items.map((i) => ({
        id: i.id,
        separator: i.separator,
        label: i.label,
        key: i.key,
        disabled: i.when ? !i.when(contextFor(entry)) : false,
        run: () => i.run(contextFor(entry), pane),
      }))
    );
  };

  // ---- drag & drop -------------------------------------------------------
  const hover = hoverPrefetch(pane);
  const vp = viewportObserver();

  const onDragStart = (e: DragEvent, entry: Entry) => {
    const p = join(path(), entry.name);
    const sel = pane.selection();
    const paths = sel.includes(p) ? sel : [p];
    if (!sel.includes(p)) pane.setSelection([p]);
    beginDrag(e, paths);
  };

  const onDropOn = async (e: DragEvent, entry: Entry) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const paths = dragPayload(e);
    if (!paths?.length) return;
    if (entry.kind !== 1 && entry.kind !== 3) return;
    const dest = join(path(), entry.name);
    if (paths.some((p) => dest === p || dest.startsWith(p + "/"))) return;
    // Alt forces copy, plain drop moves (Finder/Explorer convention).
    const op = e.altKey ? "copy" : "move";
    try {
      const res = await transport.request<{ msg: string }>("op", { op, src: paths, dest });
      toast({ title: `${op === "copy" ? "Copied" : "Moved"} ${paths.length} item(s)`, detail: res.msg });
    } catch (err) {
      toast({ title: `${op} failed`, detail: String(err), kind: "error" });
    }
    props.workspace.invalidatePane(pane.id);
    registry.emit("op:done", { pane: pane.id });
  };

  const onDropOnPane = async (e: DragEvent) => {
    const paths = dragPayload(e);
    setDropTarget(null);
    if (!paths?.length) return;
    e.preventDefault();
    const op = e.altKey ? "copy" : "move";
    try {
      const res = await transport.request<{ msg: string }>("op", { op, src: paths, dest: path() });
      toast({ title: `${op === "copy" ? "Copied" : "Moved"} ${paths.length} item(s)`, detail: res.msg });
    } catch (err) {
      toast({ title: `${op} failed`, detail: String(err), kind: "error" });
    }
    props.workspace.invalidatePane(pane.id);
  };

  // ---- rename ------------------------------------------------------------
  const baseName = (p: string) => p.split("/").pop() ?? p;

  const commitRename = async (entry: Entry, value: string) => {
    setRenaming(null);
    const name = value.trim();
    if (!name || name === entry.name) return;
    try {
      await transport.request("op", { op: "rename", src: [join(path(), entry.name)], name });
      metrics.record("op.rename", 1);
      props.workspace.invalidatePane(pane.id);
    } catch (err) {
      toast({ title: "Rename failed", detail: String(err), kind: "error" });
    }
  };

  // ---- idle prefetch of siblings ----------------------------------------
  createEffect(() => {
    if (listing().phase !== "done") return;
    const p = path();
    const hiddenNow = hidden();
    const run = () => {
      let n = 0;
      for (const e of entries()) {
        if ((e.kind === 1 || e.kind === 3) && n < 6) {
          warm(join(p, e.name), hiddenNow);
          n++;
        }
        if (n >= 6) break;
      }
    };
    const ric = (window as any).requestIdleCallback;
    const id = ric ? ric(run, { timeout: 1500 }) : setTimeout(run, 320);
    onCleanup(() => ((window as any).cancelIdleCallback ?? clearTimeout)(id));
  });

  const sortBy = (key: "name" | "size" | "mtime") => {
    const cur = pane.sort();
    pane.setSort({ key, dir: cur.key === key && cur.dir === 1 ? -1 : 1 });
  };

  const arrow = (key: string) => (pane.sort().key === key ? (pane.sort().dir === 1 ? "↑" : "↓") : "");

  return (
    <div
      onKeyDown={onKeyDown}
      tabindex="-1"
      style={{ display: "flex", "flex-direction": "column", "min-height": 0, flex: 1 }}
      onDragOver={(e) => {
        if (dragPayload(e) || e.dataTransfer?.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        if (e.dataTransfer?.files?.length) return; // OS drop handled below
        void onDropOnPane(e);
      }}
    >
      <div class="cols-head">
        <span style={{ width: "18px" }} />
        <button class={pane.sort().key === "name" ? "sorted" : ""} onClick={() => sortBy("name")}>
          Name {arrow("name")}
        </button>
        <button class={pane.sort().key === "size" ? "sorted" : ""} onClick={() => sortBy("size")} style={{ "justify-self": "end" }}>
          Size {arrow("size")}
        </button>
        <button
          class={pane.sort().key === "mtime" ? "sorted" : ""}
          onClick={() => sortBy("mtime")}
          style={{ "justify-self": "end", "min-width": "5.5em" }}
        >
          Modified {arrow("mtime")}
        </button>
      </div>

      <div
        class="rows-wrap"
        ref={scroller}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onContextMenu={(e) => openContextMenu(e)}
      >
        <Show when={showSkeleton()}>
          <div
            classList={{
              "skeleton-static": tier() !== "shimmer" && tier() !== "progress",
              "skeleton-live": tier() === "shimmer" || tier() === "progress",
            }}
          >
            <For each={Array.from({ length: Math.min(24, Math.ceil(viewH() / rowH())) })}>
              {() => (
                <div class="skeleton-row">
                  <div class="sk sk-icon" />
                  <div class="sk sk-name" style={{ width: `${30 + Math.random() * 45}%` }} />
                  <div class="sk sk-size" />
                  <div class="sk sk-date" />
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={tier() === "progress" && waiting()}>
          <div class="progress-line" />
        </Show>

        <div
          class={`rows-inner ${showSkeleton() ? "" : swapClass()}`}
          style={{ height: `${entries().length * rowH()}px` }}
        >
          <For each={windowed()}>
            {(entry, i) => {
              const index = () => range().first + i();
              const p = () => join(path(), entry.name);
              const selected = () => selection().has(p());
              return (
                <div
                  class="row"
                  classList={{
                    selected: selected(),
                    cursor: cursor() === index(),
                    "drop-target": dropTarget() === p(),
                    stagger: !showSkeleton() && index() < 8,
                  }}
                  data-kind={entry.kind}
                  data-key={entry.name}
                  style={{
                    top: `${index() * rowH()}px`,
                    height: `${rowH()}px`,
                    "--stagger": staggerDelay(index()),
                  }}
                  draggable={renaming() !== entry.name}
                  onDragStart={(e) => onDragStart(e, entry)}
                  onDragOver={(e) => {
                    if (entry.kind === 1 || entry.kind === 3) {
                      e.preventDefault();
                      setDropTarget(p());
                    }
                  }}
                  onDragLeave={() => dropTarget() === p() && setDropTarget(null)}
                  onDrop={(e) => void onDropOn(e, entry)}
                  onClick={(e) => clickRow(e, entry, index())}
                  onDblClick={() => onDblClick(entry)}
                  onContextMenu={(e) => openContextMenu(e, entry)}
                  onMouseEnter={(e) => {
                    hover.enter(entry, p());
                    if (entry.kind === 1 || entry.kind === 3) {
                      vp.observe(e.currentTarget as HTMLElement, p());
                    }
                  }}
                  onMouseLeave={(e) => {
                    hover.leave();
                    vp.unobserve(e.currentTarget as HTMLElement);
                  }}
                >
                  <span class="row-icon">
                    <Icon name={iconFor(entry)} size={15} />
                  </span>
                  <span class="row-name">
                    <Show
                      when={renaming() === entry.name}
                      fallback={
                        <>
                          <span class="base">{splitName(entry.name).base}</span>
                          <span class="ext">{splitName(entry.name).ext}</span>
                        </>
                      }
                    >
                      <input
                        class="rename-input"
                        value={entry.name}
                        autofocus
                        onClick={(e) => e.stopPropagation()}
                        onFocus={(e) => {
                          const v = e.currentTarget.value;
                          const dot = v.lastIndexOf(".");
                          e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length);
                        }}
                        onBlur={(e) => void commitRename(entry, e.currentTarget.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
                          if (e.key === "Escape") setRenaming(null);
                        }}
                      />
                    </Show>
                  </span>
                  <span class="row-size">{entry.kind === 1 ? "—" : fmtSize(entry.size)}</span>
                  <span class="row-meta" style={{ "min-width": "5.5em" }}>
                    {fmtDate(entry.mtime)}
                  </span>
                </div>
              );
            }}
          </For>
        </div>

        <Show when={!waiting() && entries().length === 0}>
          <div class="empty" style={{ position: "absolute", inset: 0 }}>
            {pane.filter() ? "nothing matches that filter" : "empty folder"}
          </div>
        </Show>
      </div>

      <Show when={listing().error}>
        <div class="empty" style={{ flex: "0 0 auto", padding: "8px", color: "var(--danger)" }}>
          {listing().error}
        </div>
      </Show>
    </div>
  );
}
