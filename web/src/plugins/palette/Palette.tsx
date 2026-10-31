import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import type { WorkspaceApi } from "../../core/types";
import { commandBus, registry, transport, toasts } from "../../core/registry";
import { Icon, iconFor } from "../../icons";
import { join, parentOf } from "../../core/workspace";

/**
 * Command palette — a plugin. The shell contributes nothing but the ability to
 * dispatch a command; even the keybinding is registered here.
 *
 * Sources: commands, plugin views, paths (jump to folder), and file search
 * (streamed from the daemon's `search` method).
 */
export default function Palette(props: { workspace?: WorkspaceApi }) {
  const [open, setOpen] = createSignal(false);
  const ws = () => props.workspace ?? (globalThis as any).__filament?.workspace;
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [hits, setHits] = createSignal<{ path: string; name: string; kind: number; size: number }[]>([]);
  let input: HTMLInputElement | undefined;

  interface Row {
    id: string;
    kind: "command" | "view" | "folder" | "file";
    label: string;
    detail?: string;
    icon?: string;
    run: () => void;
  }

  onMount(() => {
    const show = () => {
      setOpen(true);
      setQuery("");
      setActive(0);
      queueMicrotask(() => input?.focus());
    };
    const hide = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open()) {
        e.stopPropagation();
        hide();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        show();
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("filament:palette", show as EventListener);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("filament:palette", show as EventListener);
    });
  });

  // Streamed file search, debounced. Results top up as the daemon walks.
  let searchId: string | undefined;
  let timer: number | undefined;
  const runSearch = (q: string) => {
    clearTimeout(timer);
    if (searchId) transport.cancel(searchId);
    if (q.length < 2 || q.includes("/")) {
      setHits([]);
      return;
    }
    timer = setTimeout(() => {
      const pane = ws().focused();
      if (!pane) return;
      setHits([]);
      const root = parentOf(pane.path()) ?? pane.path();
      const s = transport.stream("search", { root: pane.path() || root, query: q, limit: 60 }, (frame) => {
        if (frame.ev === "hits") setHits((h) => [...h, ...frame.hits].slice(0, 60));
      });
      searchId = s.id;
      s.done.catch(() => {});
    }, 90) as unknown as number;
  };

  const rows = createMemo<Row[]>(() => {
    const q = query().trim().toLowerCase();
    const out: Row[] = [];
    const ctx = {
      workspace: props.workspace as any,
      focusedPane: ws().focused(),
      plugins: null as any,
      toasts,
    };
    for (const cmd of registry.commands.values()) {
      if (cmd.when && !cmd.when(ctx as any)) continue;
      if (q && !cmd.title.toLowerCase().includes(q) && !cmd.id.includes(q)) continue;
      out.push({
        id: `cmd:${cmd.id}`,
        kind: "command",
        label: cmd.title,
        detail: cmd.group ?? "Command",
        icon: "zap",
        run: () => commandBus.run(cmd.id),
      });
    }
    for (const view of registry.views.values()) {
      if (q && !view.title.toLowerCase().includes(q) && !view.id.includes(q)) continue;
      if (view.kind !== "pane") continue;
      out.push({
        id: `view:${view.id}`,
        kind: "view",
        label: `Open ${view.title} view`,
        detail: "View",
        icon: view.id === "grid" ? "grid" : "list",
        run: () => {
          const pane = ws().focused();
          if (pane) ws().split(pane.id, "h", view.id);
        },
      });
    }
    const focused = ws().focused();
    if (focused && q) {
      for (const e of focused.entries()) {
        if (e.kind === 1 && e.name.toLowerCase().includes(q)) {
          out.push({
            id: `dir:${e.name}`,
            kind: "folder",
            label: e.name,
            detail: "Folder here",
            icon: "folder",
            run: () => ws().navigate(focused.id, join(focused.path(), e.name)),
          });
        }
        if (out.length > 40) break;
      }
    }
    for (const hit of hits()) {
      out.push({
        id: `hit:${hit.path}`,
        kind: "file",
        label: hit.name,
        detail: hit.path.replace(/\/[^/]+$/, ""),
        icon: iconFor({ ...hit, ext: hit.name.split(".").pop() }),
        run: () => {
          const pane = ws().focused();
          if (!pane) return;
          ws().navigate(pane.id, parentOf(hit.path) ?? pane.path());
          setTimeout(() => pane.setSelection([hit.path]), 150);
        },
      });
    }
    return out.slice(0, 80);
  });

  const exec = (row?: Row) => {
    const target = row ?? rows()[active()];
    if (!target) return;
    setOpen(false);
    target.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows().length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      exec();
    }
  };

  return (
    <Show when={open()}>
      <Portal>
        <div class="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
          <div class="palette" role="dialog" aria-label="Command palette">
            <input
              ref={input}
              value={query()}
              placeholder="Type a command, a folder, or search files…"
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setActive(0);
                runSearch(e.currentTarget.value.trim());
              }}
              onKeyDown={onKey}
            />
            <div class="palette-list">
              <For each={rows()}>
                {(row, i) => (
                  <button
                    class="palette-item"
                    data-active={i() === active()}
                    onMouseEnter={() => setActive(i())}
                    onClick={() => exec(row)}
                  >
                    <Icon name={row.icon ?? "dot"} size={14} />
                    <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>{row.label}</span>
                    <span class="kind">{row.kind}</span>
                  </button>
                )}
              </For>
              <Show when={!rows().length}>
                <div class="palette-empty">nothing here</div>
              </Show>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

export function openPalette() {
  // The palette is summoned by event, not by a global: any plugin can open it
  // without importing another plugin's module.
  window.dispatchEvent(new Event("filament:palette"));
}
