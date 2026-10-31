import { createMemo, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { Entry, LayoutNode, PaneApi, SortSpec, WorkspaceApi } from "./types";
import { metrics } from "./metrics";
import { registry } from "./registry";
import { listingsRev, peek, rescan, warm, invalidate } from "./listings";
import { settings, update } from "./settings";

/**
 * Workspace = a recursive layout tree of panes, plus per-pane state.
 *
 * The tree is the *only* layout primitive:
 *   { type:"leaf", pane:"p1" }
 *   { type:"split", dir:"h"|"v", ratio:0.62, a:…, b:… }
 *
 * Panes are views; views are plugins. A pane's props may be *bindings*
 * (`$p1.selection`), which is how a preview pane follows another pane without
 * either of them knowing the other exists.
 */

export interface PaneState {
  id: string;
  view: string;
  path: string;
  /** For non-path views (preview): where its content comes from. */
  props: Record<string, string>;
  selection: string[];
  cursor: number;
  sort: SortSpec;
  filter: string;
  showHidden: boolean;
  history: string[];
  historyIndex: number;
  direction: 1 | -1 | 0;
}

interface WorkspaceState {
  tree: LayoutNode;
  panes: Record<string, PaneState>;
}

const STORAGE = "filament.workspace.v2";

/**
 * Stand-in state for a pane whose real state has gone missing. Pane APIs read
 * through this instead of `undefined`, so a layout/state mismatch degrades to
 * an empty pane rather than throwing out of a reactive computation.
 */
const FALLBACK_PANE: PaneState = {
  id: "",
  view: "list",
  path: "",
  props: {},
  selection: [],
  cursor: 0,
  sort: { key: "name", dir: 1 },
  filter: "",
  showHidden: false,
  history: [""],
  historyIndex: 0,
  direction: 0,
};

let seq = 0;
const nextId = () => `p${++seq}`;

function defaultPane(path: string, view = "list"): PaneState {
  return {
    id: nextId(),
    view,
    path,
    props: {},
    selection: [],
    cursor: 0,
    sort: { key: settings.sortKey, dir: settings.sortDir },
    filter: "",
    showHidden: settings.showHidden,
    history: [path],
    historyIndex: 0,
    direction: 0,
  };
}

function loadPersisted(): WorkspaceState | undefined {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed.tree || !parsed.panes) return undefined;
    // Prune ghosts and repair dangling leaves before anything renders: booting
    // a layout that references missing pane state is unrecoverable otherwise.
    const referenced = new Set<string>();
    const walk = (n: LayoutNode): void => {
      if (!n) return;
      if (n.type === "leaf") referenced.add(n.pane);
      else {
        walk(n.a);
        walk(n.b);
      }
    };
    walk(parsed.tree);
    if (!referenced.size) return undefined;
    for (const id of Object.keys(parsed.panes)) {
      if (!referenced.has(id)) delete parsed.panes[id];
    }
    for (const id of referenced) {
      if (!parsed.panes[id]) return undefined; // irreparable — start fresh
    }
    // Rebuild the id counter past anything restored.
    for (const id of Object.keys(parsed.panes)) {
      const n = Number(id.replace(/^\D+/, ""));
      if (Number.isFinite(n)) seq = Math.max(seq, n);
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function createWorkspace(home: string) {
  const restored = loadPersisted();
  const first = restored ?? {
    tree: { type: "leaf", pane: "p1" } as LayoutNode,
    panes: { p1: { ...defaultPane(home), id: "p1" } },
  };
  if (!restored) seq = Math.max(seq, 1);

  const [state, setState] = createStore<WorkspaceState>(first);
  const [focusedId, setFocusedId] = createSignal<string>(
    Object.keys(first.panes)[0] ?? "p1"
  );
  const [mobileTab, setMobileTab] = createSignal(0);

  // ---------------------------------------------------------------- helpers

  function pathOf(node: LayoutNode, acc: number[] = []): { pane: string; path: number[] }[] {
    if (node.type === "leaf") return [{ pane: node.pane, path: acc }];
    return [...pathOf(node.a, [...acc, 0]), ...pathOf(node.b, [...acc, 1])];
  }

  function setPane(id: string, patch: Partial<PaneState>) {
    setState("panes", id, patch as any);
  }

  let saveTimer: number | undefined;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        // Serialise only panes the tree actually references: a stale key here
        // is how a ghost layout would survive a reload.
        const live = new Set(pathOf(state.tree).map((l) => l.pane));
        const panes: Record<string, PaneState> = {};
        for (const [id, p] of Object.entries(state.panes)) {
          if (live.has(id)) panes[id] = p as PaneState;
        }
        localStorage.setItem(STORAGE, JSON.stringify({ tree: state.tree, panes }));
      } catch {
        /* ignore quota errors */
      }
    }, 180) as unknown as number;
  }

  // ---------------------------------------------------------------- pane api

  function paneApi(id: string): PaneApi {
    // Never throw on missing state: a throw inside a render/effect takes the
    // whole window down with it ("everything is frozen"), so a pane whose
    // state has gone missing degrades to an empty one instead.
    const st = () => state.panes[id] ?? FALLBACK_PANE;
    return {
      id,
      path: () => st().path,
      view: () => st().view,
      props: () => st().props,
      setView: (v) => {
        setPane(id, { view: v });
        persist();
      },
      navigate: (path, opts) => navigate(id, path, opts),
      entries: () => entriesFor(id)(),
      selection: () => st().selection,
      setSelection: (paths) => {
        setPane(id, { selection: paths });
        registry.emit("selection", { pane: id, paths });
      },
      focusedEntry: () => {
        const list = entriesFor(id)();
        const p = st().selection[st().selection.length - 1];
        return list.find((e) => join(st().path, e.name) === p);
      },
      sort: () => st().sort,
      setSort: (s) => {
        setPane(id, { sort: s });
        update("sortKey", s.key);
        update("sortDir", s.dir);
        persist();
      },
      filter: () => st().filter,
      setFilter: (f) => setPane(id, { filter: f }),
      showHidden: () => st().showHidden,
      setShowHidden: (v) => {
        setPane(id, { showHidden: v });
        persist();
      },
      phase: () => {
        listingsRev();
        return peek(st().path, st().showHidden)?.phase ?? "idle";
      },
      refresh: () => {
        rescan(st().path, st().showHidden);
      },
      requestFocus: () => focus(id, { persistTab: true }),
    };
  }

  /**
   * Rows for a pane: the cached listing, filtered and sorted.
   * Coarse reactivity through `listingsRev()` keeps this cheap and keeps the
   * sort/filter logic in one place instead of inside every view plugin.
   */
  function entriesFor(id: string) {
    return createMemo(() => {
      listingsRev();
      const st = state.panes[id];
      if (!st) return [] as Entry[];
      const rec = peek(st.path, st.showHidden);
      if (!rec) return [] as Entry[];
      const q = st.filter.trim().toLowerCase();
      let out = rec.entries;
      if (q) out = out.filter((e) => e.name.toLowerCase().includes(q));
      const { key, dir } = st.sort;
      return [...out].sort((a, b) => {
        const ad = a.kind === 1 ? 1 : 0;
        const bd = b.kind === 1 ? 1 : 0;
        if (ad !== bd) return bd - ad;
        let r = 0;
        if (key === "name") r = a.name.localeCompare(b.name, undefined, { numeric: true });
        else if (key === "size") r = a.size - b.size || a.name.localeCompare(b.name);
        else if (key === "mtime") r = a.mtime - b.mtime || a.name.localeCompare(b.name);
        else r = a.kind - b.kind || a.name.localeCompare(b.name);
        return r * dir;
      });
    });
  }

  // ---------------------------------------------------------------- navigate

  function pushHistory(st: PaneState, path: string, replace: boolean) {
    if (replace) return { history: st.history, historyIndex: st.historyIndex };
    const history = [...st.history.slice(0, st.historyIndex + 1), path];
    return { history, historyIndex: history.length - 1 };
  }

  function navigate(id: string, path: string, opts: { direction?: 1 | -1; replace?: boolean } = {}) {
    const st = state.panes[id];
    if (!st || !path || path === st.path) return;
    // Score the navigation against the prefetch cache *before* the stream
    // starts, so the hit rate reflects what the user actually felt.
    const cached = peek(path, st.showHidden);
    const hit = !!cached && (cached.phase === "done" || cached.entries.length > 0);
    metrics.record(hit ? "prefetch.hit" : "prefetch.miss", 1);
    metrics.record("nav.count", 1);
    metrics.record(hit ? "nav.cached" : "nav.cold", 1);

    const { history, historyIndex } = pushHistory(st, path, !!opts.replace);
    setPane(id, {
      path,
      history,
      historyIndex,
      selection: [],
      cursor: 0,
      direction: opts.direction ?? 1,
    });
    registry.emit("navigate", { pane: id, path, hit });
    if (focusedId() === id) syncHash(path);
    persist();
  }

  function goBack(id: string) {
    const st = state.panes[id];
    if (!st || st.historyIndex <= 0) return;
    setPane(id, {
      path: st.history[st.historyIndex - 1],
      historyIndex: st.historyIndex - 1,
      selection: [],
      cursor: 0,
      direction: -1,
    });
    if (focusedId() === id) syncHash(state.panes[id].path);
    persist();
    metrics.record("nav.back", 1);
  }

  function goForward(id: string) {
    const st = state.panes[id];
    if (!st || st.historyIndex >= st.history.length - 1) return;
    setPane(id, {
      path: st.history[st.historyIndex + 1],
      historyIndex: st.historyIndex + 1,
      selection: [],
      cursor: 0,
      direction: 1,
    });
    if (focusedId() === id) syncHash(state.panes[id].path);
    persist();
    metrics.record("nav.forward", 1);
  }

  // ------------------------------------------------------------------ layout

  /** Views that render *another pane's* state instead of their own folder. */
  const BOUND_VIEWS = new Set(["preview"]);

  function split(paneId: string, dir: "h" | "v", view?: string) {
    const st = state.panes[paneId];
    if (!st) return;
    const id = nextId();
    const nextView = view ?? st.view;
    const bound = BOUND_VIEWS.has(nextView);
    const np = { ...defaultPane(bound ? "" : st.path, nextView), id } as PaneState;
    if (bound) np.props = { source: `$${paneId}` };
    setState(produce((s) => {
      s.panes[id] = np;
      s.tree = insertSplit(s.tree, paneId, dir, id);
    }));
    setFocusedId(id);
    persist();
    metrics.record("pane.split", 1);
  }

  function insertSplit(node: LayoutNode, paneId: string, dir: "h" | "v", newId: string): LayoutNode {
    if (node.type === "leaf") {
      if (node.pane !== paneId) return node;
      return { type: "split", dir, ratio: 0.5, a: node, b: { type: "leaf", pane: newId } };
    }
    return { ...node, a: insertSplit(node.a, paneId, dir, newId), b: insertSplit(node.b, paneId, dir, newId) };
  }

  function close(paneId: string) {
    const leaves = pathOf(state.tree).map((l) => l.pane);
    if (leaves.length <= 1) return;
    const idx = leaves.indexOf(paneId);
    // Only a leaf can be closed. Deleting the *state* of an id that is not in
    // the tree leaves a leaf pointing at nothing, and the first `pane.path()`
    // on it throws — which is what used to freeze the window.
    if (idx === -1) return;
    // Take the successor from the tree, before mutating. `Object.keys(pane
    // map)` is not a reliable neighbour: read right after produce() it can
    // still contain the key we just deleted, which is how focus used to land
    // on a corpse and every pane command started silently no-oping.
    const next = leaves[idx + 1] ?? leaves[idx - 1];
    const wasFocused = focusedId() === paneId;
    setState(produce((s) => {
      s.tree = removeLeaf(s.tree, paneId)!;
      delete s.panes[paneId];
    }));
    if (wasFocused || !state.panes[focusedId()]) setFocusedId(next);
    // Belt and braces: if that neighbour is gone too, take the first live leaf.
    if (!state.panes[focusedId()]) {
      const alive = pathOf(state.tree)
        .map((l) => l.pane)
        .filter((id) => !!state.panes[id]);
      if (alive.length) setFocusedId(alive[0]);
    }
    persist();
    metrics.record("pane.close", 1);
  }

  function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | undefined {
    if (node.type === "leaf") return node.pane === paneId ? undefined : node;
    const a = removeLeaf(node.a, paneId);
    const b = removeLeaf(node.b, paneId);
    if (!a && !b) return undefined;
    if (!a) return b;
    if (!b) return a;
    return { ...node, a, b };
  }

  function setRatio(path: number[], ratio: number) {
    setState(produce((s) => {
      let node: LayoutNode = s.tree;
      for (const step of path) {
        if (node.type !== "split") return;
        node = step === 0 ? node.a : node.b;
      }
      if (node.type === "split") node.ratio = Math.min(0.9, Math.max(0.1, ratio));
    }));
    persist();
  }

  const [focusTick, setFocusTick] = createSignal(0);

  function focus(id: string, opts: { persistTab?: boolean } = {}) {
    if (!state.panes[id]) return;
    setFocusedId(id);
    setFocusTick((t) => t + 1);
    if (opts.persistTab) {
      const leaves = pathOf(state.tree).map((l) => l.pane);
      setMobileTab(leaves.indexOf(id));
    }
    const st = state.panes[id];
    if (st?.path) syncHash(st.path);
  }

  // ------------------------------------------------------------------ router

  function syncHash(path: string) {
    const target = `#${path}`;
    if (location.hash !== target) {
      try {
        history.replaceState(null, "", target);
      } catch {
        /* ignore */
      }
    }
  }

  function applyHash() {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) return;
    navigate(focusedId(), raw);
  }

  // ----------------------------------------------------------------- bindings

  const BINDING = /^\$([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?$/;

  function resolve(expr: string): any {
    focusTick();
    const m = BINDING.exec(expr?.trim() ?? "");
    if (!m) return expr;
    const [, paneRef, field = "selection"] = m;
    const id = paneRef === "focused" ? focusedId() : paneRef;
    const st = state.panes[id];
    if (!st) return undefined;
    switch (field) {
      case "path":
        return st.path;
      case "selection":
        return st.selection;
      case "selected":
        return st.selection[st.selection.length - 1];
      case "cursor":
        return st.selection[st.selection.length - 1];
      case "entries":
        return entriesFor(id)();
      case "view":
        return st.view;
      default:
        return st[field as keyof PaneState];
    }
  }

  // --------------------------------------------------------------- public api

  const panes = createMemo<PaneApi[]>(() => Object.keys(state.panes).map((id) => paneApi(id)));

  const api: WorkspaceApi = {
    panes,
    focusedId: () => (state.panes[focusedId()] ? focusedId() : undefined),
    focus,
    entriesFor: (id: string) => entriesFor(id)(),
    invalidatePane: (id: string) => {
      const st = state.panes[id];
      if (!st) return;
      invalidate(st.path);
    },
    navigate,
    warmUp,
    focused: () => (state.panes[focusedId()] ? paneApi(focusedId()) : undefined),
    pane: (id) => (state.panes[id] ? paneApi(id) : undefined),
    split,
    close,
    setRatio,
    tree: () => state.tree,
    setPaneView: (paneId, view) => {
      setPane(paneId, { view });
      persist();
      metrics.record("pane.setView", 1);
    },
    addPaneForView: (view, opts) => {
      const target = opts?.paneId ?? focusedId();
      split(target, opts?.dir ?? "h", view);
    },
    resolve,
    goBack,
    goForward,
    paneDirection: (paneId) => state.panes[paneId]?.direction ?? 0,
    historyState: (paneId) => {
      const st = state.panes[paneId];
      return { index: st?.historyIndex ?? 0, length: st?.history.length ?? 0 };
    },
  };

  // -------------------------------------------------------- prefetch triggers

  /** Warm the history of the focused pane, and the siblings of its parent. */
  function warmUp(path: string) {
    if (!settings.idlePrefetch) return;
    const hidden = state.panes[focusedId()]?.showHidden ?? false;
    const warmOne = (p: string) => warm(p, hidden);
    const parent = parentOf(path);
    if (parent) {
      const sib = peek(parent, hidden);
      if (sib?.entries) {
        let n = 0;
        for (const e of sib.entries) {
          if (e.kind === 1 && n < 6) {
            const p = join(parent, e.name);
            if (p !== path) {
              warmOne(p);
              n++;
            }
          }
        }
      }
    }
    // Warm the two most recent back/forward targets.
    const st = state.panes[focusedId()];
    if (st) {
      const prev = st.history[st.historyIndex - 1];
      if (prev) warmOne(prev);
      const next = st.history[st.historyIndex + 1];
      if (next) warmOne(next);
    }
  }

  return {
    api,
    state,
    focusedId,
    focus,
    mobileTab,
    setMobileTab,
    navigate,
    goBack,
    goForward,
    entriesFor: (id: string) => entriesFor(id)(),
    invalidatePane: (id: string) => {
      const st = state.panes[id];
      if (!st) return;
      invalidate(st.path);
    },
    applyHash,
    warmUp,
    setPane,
    notify: () => setFocusTick((t) => t + 1),
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;

// ------------------------------------------------------------------ util fns

export function join(dir: string, name: string): string {
  if (name.includes("!/")) return name;
  if (dir.endsWith("/")) return dir + name;
  return `${dir}/${name}`;
}

export function parentOf(path: string): string | undefined {
  if (path.includes("!/")) {
    const [archive, inner] = path.split("!/");
    const parts = inner.split("/").filter(Boolean);
    parts.pop();
    return parts.length ? `${archive}!/${parts.join("/")}` : archive;
  }
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  if (i <= 0) return undefined;
  return trimmed.slice(0, i);
}

export function baseName(path: string): string {
  if (path.includes("!/")) {
    const [archive, inner] = path.split("!/");
    return inner.split("/").filter(Boolean).pop() ?? archive;
  }
  return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

export function isArchivePath(path: string): boolean {
  return path.includes("!/");
}

export function crumbs(path: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  if (path.includes("!/")) {
    const [archive, inner] = path.split("!/");
    for (const c of crumbs(archive)) out.push(c);
    let acc = `${archive}!/`;
    const parts = inner.split("/").filter(Boolean);
    parts.forEach((p, i) => {
      acc = i === 0 ? acc + p : acc + "/" + p;
      out.push({ label: p, path: acc });
    });
    return out;
  }
  const unix = path.startsWith("/");
  const parts = path.split("/").filter(Boolean);
  let acc = unix ? "" : "";
  for (const p of parts) {
    acc += "/" + p;
    out.push({ label: p, path: acc });
  }
  return out;
}
