import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Dynamic } from "solid-js/web";
import { commandBus, currentContext, registry } from "../core/registry";
import type { ChromeSlot } from "../core/types";
import type { Workspace } from "../core/workspace";
import { Icon } from "../icons";
import { LayoutTree } from "./Pane";
import { MenuHost, PromptHost, ToastHost } from "./overlays";
import { settings, update } from "../core/settings";

/**
 * The shell. Deliberately thin: it owns a topbar, a sidebar slot, the layout
 * tree, a status bar and the overlay hosts — and nothing else. Every visible
 * element inside those regions belongs to a plugin.
 */
export function App(props: { workspace: Workspace; home: string }) {
  const [drawer, setDrawer] = createSignal(false);
  const panes = createMemo(() => props.workspace.api.panes());

  onMount(() => {
    document.documentElement.dataset.theme = settings.theme;
    document.documentElement.dataset.motion = settings.motion === "reduced" ? "reduced" : "full";
    document.documentElement.dataset.density = settings.density;
  });

  return (
    <div class="app" data-drawer={drawer() ? "open" : "closed"}>
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="icon-btn drawer-toggle"
            title="Places"
            aria-label="Toggle places"
            onClick={() => setDrawer((d) => !d)}
          >
            <Icon name="layers" />
          </button>
          <Slot slot="topbar-left" workspace={props.workspace} />
        </div>
        <div class="topbar-center">
          <Slot slot="topbar-center" workspace={props.workspace} />
        </div>
        <div class="topbar-right">
          <Slot slot="topbar-right" workspace={props.workspace} />
          <button
            class="icon-btn"
            title="Cycle theme"
            aria-label="Cycle theme"
            onClick={() => {
              const ids = [...registry.themes.keys()];
              if (!ids.length) return;
              const i = ids.indexOf(settings.theme);
              const next = ids[(i + 1) % ids.length];
              update("theme", next);
              void registry.themes.get(next)?.load();
            }}
          >
            <Icon name="palette" />
          </button>
          <button
            class="icon-btn"
            title="Command palette (Ctrl/Cmd+K)"
            aria-label="Command palette"
            onClick={() => commandBus.run("palette.open")}
          >
            <Icon name="sparkle" />
          </button>
        </div>
      </header>

      <div class="app-body">
        <div class="drawer-scrim" onClick={() => setDrawer(false)} />
        <aside class="sidebar" role="navigation" aria-label="Places">
          <Slot slot="sidebar" workspace={props.workspace} />
        </aside>
        <main class="main">
          <LayoutTree workspace={props.workspace} />
        </main>
      </div>

      <footer class="statusbar">
        <Slot slot="status" workspace={props.workspace} />
      </footer>

      <MenuHost />
      <PromptHost />
      <ToastHost />
      <GlobalKeys workspace={props.workspace} />
      <Show when={panes().length === 0}>
        <div class="empty">no panes — reopen a view from the palette</div>
      </Show>
    </div>
  );
}

/** Renders every plugin that registered into a chrome slot. */
function Slot(props: { slot: ChromeSlot; workspace: Workspace }) {
  const items = createMemo(() => {
    registry.revision();
    return registry.chrome.get(props.slot) ?? [];
  });
  return (
    <For each={items()}>
      {(item) => <LazyComponent load={item.load} workspace={props.workspace.api} />}
    </For>
  );
}

function LazyComponent(props: { load: () => Promise<{ default: any }>; workspace: any }) {
  const [Comp, setComp] = createSignal<any>(null);
  void props.load().then((m) => setComp(() => m.default));
  return (
    <Show when={Comp()}>
      <Dynamic component={Comp()} workspace={props.workspace} />
    </Show>
  );
}

/**
 * Global key handling. Keybindings are *registered by plugins* — the core only
 * owns the dispatcher.
 */
function GlobalKeys(_props: { workspace: Workspace }) {
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing =
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    const combo = comboOf(e);
    if (!combo) return;
    for (const cmd of registry.commands.values()) {
      if (cmd.key !== combo) continue;
      if (typing && !combo.includes("mod+")) continue;
      const ctx = currentContext();
      if (cmd.when && ctx && !cmd.when(ctx)) continue;
      e.preventDefault();
      e.stopPropagation();
      commandBus.run(cmd.id);
      return;
    }
  };
  onMount(() => window.addEventListener("keydown", onKeyDown, true));
  onCleanup(() => window.removeEventListener("keydown", onKeyDown, true));
  return null;
}

function comboOf(e: KeyboardEvent): string | undefined {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const k = e.key.toLowerCase();
  if (["control", "meta", "alt", "shift"].includes(k)) return undefined;
  parts.push(k);
  return parts.join("+");
}
