// Core type surface. Everything a plugin can see lives here.

export interface Entry {
  name: string;
  /** 0=file 1=dir 2=symlink 3=archive */
  kind: number;
  size: number;
  mtime: number;
  ext?: string;
}

export interface PluginManifest {
  id: string;
  version: string;
  kind: string;
  capabilities: string[];
  hooks: string[];
  matches: string[];
}

export type ViewHost = "pane" | "chrome-slot" | "overlay";

export interface ViewDefinition {
  id: string;
  title: string;
  /** Component loader — dynamic import so views are code-split. */
  load: () => Promise<{ default: any }>;
  /** Pane views receive a PaneApi; chrome views receive their own props. */
  kind: ViewHost;
}

export interface Command {
  id: string;
  title: string;
  /** Solid's keybinding grammar, e.g. "mod+shift+p". */
  key?: string;
  group?: string;
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext, arg?: any) => void | Promise<void>;
}

export interface CommandContext {
  workspace: WorkspaceApi;
  focusedPane: PaneApi | undefined;
  plugins: PluginApi;
  toasts: ToastApi;
}

export interface ToastApi {
  show: (t: { title: string; detail?: string; kind?: "info" | "warn" | "error" }) => void;
}

export interface StatusItemRegistration {
  id: string;
  position: "left" | "right";
  component: () => Promise<{ default: any }>;
  order?: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  key?: string;
  separator?: boolean;
  danger?: boolean;
  /** Only show when this returns true for the current selection. */
  when?: (sel: SelectionInfo) => boolean;
  run: (sel: SelectionInfo, pane: PaneApi) => void | Promise<void>;
}

export interface SelectionInfo {
  paths: string[];
  entries: Entry[];
  /** The entry under the cursor (not necessarily selected). */
  focused?: { path: string; entry: Entry };
  isDir: boolean;
  isSingle: boolean;
  panePath: string;
}

export interface ThemeDefinition {
  id: string;
  title: string;
  load: () => Promise<{ default?: unknown }>;
}

export interface PluginContext {
  id: string;
  registerView: (def: ViewDefinition) => void;
  registerCommand: (cmd: Command) => void;
  registerContextMenuItem: (item: ContextMenuItem) => void;
  registerStatusItem: (item: StatusItemRegistration) => void;
  registerTheme: (theme: ThemeDefinition) => void;
  registerChromeSlot: (slot: ChromeSlot, component: () => Promise<{ default: any }>) => void;
  /** Fires when a mounted pane navigates or changes selection. */
  on: (event: EventName, handler: (payload: any) => void) => () => void;
  emit: (event: EventName, payload?: any) => void;
  commands: CommandBusApi;
  workspace: WorkspaceApi;
  toasts: ToastApi;
  pluginManifests: () => PluginManifest[];
  metrics: MetricsApi;
}

export type ChromeSlot = "sidebar" | "topbar-left" | "topbar-center" | "topbar-right" | "status";

export type EventName =
  | "navigate"
  | "selection"
  | "listing:done"
  | "op:done"
  | "view:mounted"
  | "theme:changed";

export interface MetricsApi {
  snapshot: () => Record<string, number>;
  record: (key: string, value: number) => void;
  push: (key: string, value: number) => void;
  reset: () => void;
  signal: () => number;
}

export interface PluginModule {
  default: {
    id: string;
    name?: string;
    activate: (ctx: PluginContext) => void | Promise<void>;
  };
}

// ---- Pane / workspace -----------------------------------------------------

export interface PaneApi {
  id: string;
  path: () => string;
  view: () => string;
  /** View props (may contain `$paneId.field` bindings). */
  props: () => Record<string, string>;
  setView: (v: string) => void;
  navigate: (path: string, opts?: { direction?: 1 | -1; replace?: boolean }) => void;
  entries: () => Entry[];
  selection: () => string[];
  setSelection: (paths: string[]) => void;
  focusedEntry: () => Entry | undefined;
  sort: () => SortSpec;
  setSort: (s: SortSpec) => void;
  filter: () => string;
  setFilter: (f: string) => void;
  showHidden: () => boolean;
  setShowHidden: (v: boolean) => void;
  phase: () => string;
  refresh: () => void;
  /** Navigate a different pane (used by cross-pane DnD and preview follow). */
  requestFocus: () => void;
}

export interface SortSpec {
  key: "name" | "size" | "mtime" | "kind";
  dir: 1 | -1;
}

export interface WorkspaceApi {
  panes: () => PaneApi[];
  /** id of the pane that currently has focus */
  focusedId: () => string | undefined;
  focus: (paneId: string, opts?: { persistTab?: boolean }) => void;
  /** Rows for a pane: cached + filtered + sorted (views render this). */
  entriesFor: (paneId: string) => Entry[];
  /** Drop a pane's cached listing and rescan (after a mutation). */
  invalidatePane: (paneId: string) => void;
  navigate: (paneId: string, path: string, opts?: { direction?: 1 | -1; replace?: boolean }) => void;
  /** Idle warm-up of siblings/history for the given folder. */
  warmUp: (path: string) => void;
  focused: () => PaneApi | undefined;
  pane: (id: string) => PaneApi | undefined;
  split: (paneId: string, dir: "h" | "v", view?: string) => void;
  close: (paneId: string) => void;
  setRatio: (path: number[], ratio: number) => void;
  tree: () => LayoutNode;
  setPaneView: (paneId: string, view: string) => void;
  addPaneForView: (view: string, opts?: { paneId?: string; dir?: "h" | "v" }) => void;
  /** Resolve a `$paneId.field` binding expression. */
  resolve: (expr: string) => any;
  goBack: (paneId: string) => void;
  goForward: (paneId: string) => void;
  /** Last navigation direction for a pane: 1 forward, -1 back, 0 none. */
  paneDirection: (paneId: string) => 1 | -1 | 0;
  historyState: (paneId: string) => { index: number; length: number };
}

export type LayoutNode =
  | { type: "leaf"; pane: string }
  | { type: "split"; dir: "h" | "v"; ratio: number; a: LayoutNode; b: LayoutNode };

export interface CommandBusApi {
  run: (id: string, arg?: any) => void;
  list: () => Command[];
}

export interface PluginApi {
  load: (id: string) => Promise<void>;
  loaded: () => string[];
  all: () => { id: string; views: string[]; commands: string[] }[];
}
