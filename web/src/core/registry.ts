import { createSignal } from "solid-js";
import type {
  ChromeSlot,
  Command,
  CommandContext,
  ContextMenuItem,
  EventName,
  PluginContext,
  StatusItemRegistration,
  ThemeDefinition,
  ViewDefinition,
} from "./types";
import { metrics } from "./metrics";
import { transport } from "./transport";
import type { WorkspaceApi } from "./types";

/**
 * The plugin host.
 *
 * The shell itself is composed from plugins: list view, grid view, sidebar,
 * preview, address bar, palette, status bar and the themes are all ordinary
 * plugins loaded through `pluginHost.load(id)`. The irreducible core is
 * transport + registries + layout + router.
 *
 * Every plugin body is behind `() => import(...)`, so installing forty plugins
 * costs two chunks on first paint and the rest on first use.
 */

type PluginFactory = () => Promise<{ default: { id: string; activate: (c: PluginContext) => unknown } }>;

/** The built-in plugin catalogue (id → dynamic import). */
export const CATALOGUE: Record<string, PluginFactory> = {
  "list-view": () => import("../plugins/list/index"),
  "grid-view": () => import("../plugins/grid/index"),
  sidebar: () => import("../plugins/sidebar/index"),
  preview: () => import("../plugins/preview/index"),
  addressbar: () => import("../plugins/addressbar/index"),
  palette: () => import("../plugins/palette/index"),
  panes: () => import("../plugins/panes/index"),
  statusbar: () => import("../plugins/statusbar/index"),
  search: () => import("../plugins/search/index"),
  contextmenu: () => import("../plugins/contextmenu/index"),
  settings: () => import("../plugins/settings/index"),
  keys: () => import("../plugins/keys/index"),
  perf: () => import("../plugins/perf/index"),
  inspector: () => import("../plugins/inspector/index"),
  ember: () => import("../plugins/themes/ember/index"),
  slate: () => import("../plugins/themes/slate/index"),
  "paper-ink": () => import("../plugins/themes/paper-ink/index"),
};

/** Which plugin owns which view id (used to lazily load an unregistered view). */
const VIEW_PLUGIN: Record<string, string> = {
  list: "list-view",
  grid: "grid-view",
  preview: "preview",
  search: "search",
};

class Registry {
  views = new Map<string, ViewDefinition>();
  commands = new Map<string, Command>();
  contextMenu = new Map<string, ContextMenuItem>();
  statusItems = new Map<string, StatusItemRegistration>();
  themes = new Map<string, ThemeDefinition>();
  chrome = new Map<ChromeSlot, { id: string; load: () => Promise<{ default: any }> }[]>();
  private listeners = new Map<EventName, Set<(p: any) => void>>();
  private loadedIds = new Set<string>();
  private loading = new Map<string, Promise<void>>();
  private version = createSignal(0);

  /** Reactive tick: bumping this invalidates lists rendered from registries. */
  readonly revision = this.version[0];

  private bump() {
    this.version[1]((v) => v + 1);
  }

  isLoaded(id: string) {
    return this.loadedIds.has(id);
  }

  loadedList() {
    return [...this.loadedIds];
  }

  /** Loads whichever plugin provides `viewId`, if we know of one. */
  async ensureView(viewId: string) {
    if (this.views.has(viewId)) return;
    const pluginId = VIEW_PLUGIN[viewId] ?? viewId;
    if (CATALOGUE[pluginId]) await this.load(pluginId);
  }

  async load(id: string) {
    if (this.loadedIds.has(id)) return;
    const existing = this.loading.get(id);
    if (existing) return existing;
    const factory = CATALOGUE[id];
    if (!factory) throw new Error(`unknown plugin '${id}'`);
    const p = (async () => {
      const t0 = performance.now();
      const mod = await factory();
      const ctx = this.contextFor(mod.default.id ?? id);
      await mod.default.activate(ctx);
      this.loadedIds.add(id);
      metrics.record("plugin.loaded", 1);
      metrics.push("plugin.loadMs", performance.now() - t0);
      this.bump();
    })();
    this.loading.set(id, p);
    try {
      await p;
    } finally {
      this.loading.delete(id);
    }
  }

  loadAll(ids: string[]) {
    // Parallel, order-independent: nothing in the core waits on any one of
    // them, and each one paints when it arrives.
    return Promise.allSettled(ids.map((id) => this.load(id)));
  }

  contextFor(id: string): PluginContext {
    return {
      id,
      registerView: (def) => {
        this.views.set(def.id, def);
        this.bump();
      },
      registerCommand: (cmd) => {
        this.commands.set(cmd.id, cmd);
        this.bump();
      },
      registerContextMenuItem: (item) => {
        this.contextMenu.set(item.id, item);
        this.bump();
      },
      registerStatusItem: (item) => {
        this.statusItems.set(item.id, item);
        this.bump();
      },
      registerTheme: (theme) => {
        this.themes.set(theme.id, theme);
        this.bump();
      },
      registerChromeSlot: (slot, load) => {
        const list = this.chrome.get(slot) ?? [];
        list.push({ id: `${id}:${slot}`, load });
        this.chrome.set(slot, list);
        this.bump();
      },
      on: (event, handler) => {
        const set = this.listeners.get(event) ?? new Set();
        set.add(handler);
        this.listeners.set(event, set);
        return () => set.delete(handler);
      },
      emit: (event, payload) => this.emit(event, payload),
      commands: {
        run: (cid, arg) => commandBus.run(cid, arg),
        list: () => [...this.commands.values()],
      },
      workspace: workspaceApi,
      toasts: toasts,
      pluginManifests: () => backendManifests(),
      metrics,
    } as PluginContext;
  }

  emit(event: EventName, payload?: any) {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const l of set) {
      try {
        l(payload);
      } catch (e) {
        console.error(`plugin event handler '${event}' threw`, e);
      }
    }
  }
}

export const registry = new Registry();

// ---- toast surface --------------------------------------------------------

const toasts = {
  show(t: { title: string; detail?: string; kind?: "info" | "warn" | "error" }) {
    window.dispatchEvent(new CustomEvent("filament:toast", { detail: t }));
  },
};

let manifests: any[] = [];
export function setBackendManifests(list: any[]) {
  manifests = list;
}
function backendManifests() {
  return manifests;
}

// The command bus needs a snapshot of live state (focused pane, toasts, etc.).
// It is installed by main.tsx once the workspace exists.
let contextProvider: (() => CommandContext) | undefined;
export function installCore(api: {
  workspace: WorkspaceApi;
  context: () => CommandContext;
}) {
  workspaceApi = api.workspace;
  contextProvider = api.context;
}
export function currentContext(): CommandContext {
  return contextProvider!();
}

export let workspaceApi: any;

// ---- command bus ----------------------------------------------------------

class CommandBus {
  run(id: string, arg?: any) {
    const cmd = registry.commands.get(id);
    if (!cmd) {
      toasts.show({ title: `No such command: ${id}`, kind: "error" });
      return;
    }
    const ctx = currentContext();
    try {
      const r = cmd.run(ctx, arg);
      if (r instanceof Promise) {
        r.catch((e) => toasts.show({ title: id, detail: String(e), kind: "error" }));
      }
    } catch (e) {
      toasts.show({ title: id, detail: String(e), kind: "error" });
    }
    metrics.record("command.run", 1);
  }
  available(ctx: CommandContext) {
    return [...registry.commands.values()].filter((c) => !c.when || c.when(ctx));
  }
}

export const commandBus = new CommandBus();

/** Keyboard-combo string for a KeyboardEvent ("mod+shift+p"). */
export function keyCombo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const k = e.key.toLowerCase();
  if (k !== "control" && k !== "meta" && k !== "alt" && k !== "shift") parts.push(k);
  return parts.join("+");
}

export { toasts, transport };
