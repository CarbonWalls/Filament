import { onCleanup } from "solid-js";
import type { Entry, PaneApi } from "./types";
import { warm } from "./listings";
import { settings } from "./settings";

/** Shared helpers for view plugins. Views are plugins, so this is a public API. */

const UNITS = ["B", "K", "M", "G", "T", "P"];
export function fmtSize(n: number): string {
  if (n === 0) return "0";
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v < 10 && i > 0 ? 1 : 0;
  return `${v.toFixed(digits)}${i === 0 ? "" : " "}${UNITS[i]}`;
}

const DTF = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
export function fmtDate(ms: number): string {
  if (!ms) return "—";
  return DTF.format(new Date(ms));
}

export function fmtRelative(ms: number): string {
  if (!ms) return "unknown";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export function fmtBytesExact(n: number): string {
  return `${n.toLocaleString()} bytes`;
}

export function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { base: name, ext: "" };
  return { base: name.slice(0, dot), ext: name.slice(dot) };
}

export const isMedia = (e: Entry) =>
  ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif", "svg"].includes((e.ext ?? "").toLowerCase());

export const isAudio = (e: Entry) =>
  ["mp3", "wav", "flac", "ogg", "m4a", "aac"].includes((e.ext ?? "").toLowerCase());

export const isVideo = (e: Entry) =>
  ["mp4", "webm", "mkv", "mov"].includes((e.ext ?? "").toLowerCase());

/**
 * Hover prefetch: 120 ms of dwell on a folder is a strong signal the user is
 * about to open it. Pointer-coarse devices skip this (no hover to speak of).
 */
export function hoverPrefetch(pane: PaneApi) {
  let timer: number | undefined;
  let last = "";
  const enter = (entry: Entry, path: string) => {
    if (!settings.hoverPrefetch) return;
    if (entry.kind !== 1 && entry.kind !== 3) return;
    if (path === last) return;
    last = path;
    clearTimeout(timer);
    timer = setTimeout(() => warm(path, pane.showHidden()), 120) as unknown as number;
  };
  const leave = () => clearTimeout(timer);
  onCleanup(() => clearTimeout(timer));
  return { enter, leave };
}

/**
 * Viewport prefetch: anything visible in a grid/list gets warmed on idle.
 * Implemented with IntersectionObserver so it costs nothing while scrolling.
 */
export function viewportObserver() {
  const pending = new Set<string>();
  const io =
    typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(
          (entries) => {
            for (const e of entries) {
              if (!e.isIntersecting) continue;
              const path = (e.target as HTMLElement).dataset.warmPath;
              if (path) pending.add(path);
            }
            if (pending.size) {
              const batch = [...pending];
              pending.clear();
              const run = () => batch.forEach((p) => warm(p));
              (window.requestIdleCallback as any)?.(run, { timeout: 800 }) ?? setTimeout(run, 60);
            }
          },
          { rootMargin: "160px" }
        )
      : undefined;
  onCleanup(() => io?.disconnect());
  return {
    observe: (el: HTMLElement, path: string) => {
      if (!settings.viewportPrefetch) return;
      el.dataset.warmPath = path;
      io?.observe(el);
    },
    unobserve: (el: HTMLElement) => io?.unobserve(el),
  };
}

/** Internal drag payload: only Filament panes understand it. */
export const DND_TYPE = "application/x-filament-paths";

export function beginDrag(e: DragEvent, paths: string[]) {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(paths));
  e.dataTransfer.setData("text/plain", paths.join("\n"));
  e.dataTransfer.effectAllowed = "copyMove";
}

export function dragPayload(e: DragEvent): string[] | undefined {
  const raw = e.dataTransfer?.getData(DND_TYPE);
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Clipboard helper that never throws (file:// and http differ). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      return true;
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

/** Range selection for shift+click / shift+arrow. */
export function rangeSelection(entries: Entry[], a: number, b: number, join: (n: string) => string) {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return entries.slice(lo, hi + 1).map((e) => join(e.name));
}
