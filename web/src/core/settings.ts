import { createStore } from "solid-js/store";

/** Persisted, reactive settings. Nothing here is required for correctness. */

export interface Settings {
  theme: string;
  density: "comfortable" | "compact";
  showHidden: boolean;
  sortKey: "name" | "size" | "mtime" | "kind";
  sortDir: 1 | -1;
  /** Motion policy: "auto" follows prefers-reduced-motion. */
  motion: "auto" | "full" | "reduced";
  viewTransitions: boolean;
  confirmDelete: boolean;
  /** Prefetch triggers. */
  hoverPrefetch: boolean;
  viewportPrefetch: boolean;
  idlePrefetch: boolean;
  /** Terminal style: keyboard-first help */
  icons: "symbols" | "minimal";
}

const KEY = "filament.settings.v1";

const initial: Settings = {
  theme: "ember",
  density: "comfortable",
  showHidden: false,
  sortKey: "name",
  sortDir: 1,
  motion: "auto",
  viewTransitions: true,
  confirmDelete: false,
  hoverPrefetch: true,
  viewportPrefetch: true,
  idlePrefetch: true,
  icons: "symbols",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...initial };
    return { ...initial, ...JSON.parse(raw) };
  } catch {
    return { ...initial };
  }
}

const [settings, setSettings] = createStore<Settings>(load());

export { settings };

export function update<K extends keyof Settings>(key: K, value: Settings[K]) {
  setSettings(key, value as any);
  persist();
}

export function setMany(patch: Partial<Settings>) {
  setSettings(patch as any);
  persist();
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...settings }));
  } catch {
    /* storage disabled — settings stay in-memory */
  }
}

/** True when animations should be suppressed right now. */
export function reducedMotion(): boolean {
  if (settings.motion === "reduced") return true;
  if (settings.motion === "full") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
