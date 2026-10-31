import { createSignal, type Accessor } from "solid-js";
import { transport } from "./transport";
import { metrics } from "./metrics";
import type { Entry } from "./types";

/**
 * Listing store — the heart of the two-phase render.
 *
 * One record per (path, showHidden). A record holds the *previous* listing
 * (streamed from SQLite by the daemon, or already in memory) so a navigation
 * can paint rows on frame 0, then reconciles the fresh scan over the top.
 *
 * Prefetch is just `warm()` without caring who asked: a hovered folder, a
 * viewport-visible grid cell and a real navigation share one record, so a
 * prefetched folder is a *hit* — one frame, zero skeletons.
 *
 * Records survive navigation in an LRU of 100 directories, which is what keeps
 * back/forward instant and makes the >80% hit target reachable.
 */

export type Phase = "idle" | "cache" | "streaming" | "done" | "error";

export interface Listing {
  path: string;
  entries: Entry[];
  /** Bumped whenever the row set changes (FLIP + FLIP-friendly patching). */
  rev: number;
  phase: Phase;
  total: number;
  error?: string;
  /** Cached rows matched the directory's own mtime when we asked. */
  cacheValid: boolean;
  fromCache: boolean;
  ttfbMs?: number;
  scanMs?: number;
  startedAt: number;
}

interface Rec {
  sig: ReturnType<typeof createSignal<Listing>>;
  stream?: { id: string; done: Promise<unknown> };
  asked?: boolean;
}

const records = new Map<string, Rec>();
const lru: string[] = [];
const LRU_MAX = 100;

const [rev, setRev] = createSignal(0);
/** Global revision signal: bump on any listing change (coarse invalidation). */
export const listingsRev = rev;

const keyOf = (path: string, showHidden: boolean) => `${showHidden ? "1" : "0"}:${path}`;

function touch(key: string) {
  const i = lru.indexOf(key);
  if (i >= 0) lru.splice(i, 1);
  lru.push(key);
  while (lru.length > LRU_MAX) {
    const old = lru[0];
    const rec = records.get(old);
    if (rec && !rec.stream && old !== key) {
      lru.shift();
      records.delete(old);
    } else break;
  }
}

function blank(path: string): Listing {
  return {
    path,
    entries: [],
    rev: 0,
    phase: "idle",
    total: 0,
    cacheValid: false,
    fromCache: false,
    startedAt: performance.now(),
  };
}

function recFor(path: string, showHidden: boolean): Rec {
  const key = keyOf(path, showHidden);
  let rec = records.get(key);
  if (!rec) {
    rec = { sig: createSignal<Listing>(blank(path)) } as unknown as Rec;
    records.set(key, rec);
  }
  touch(key);
  return rec;
}

const patch = (rec: Rec, p: Partial<Listing>) => {
  rec.sig[1]((prev) => ({ ...prev, ...p }));
  setRev((v) => v + 1);
};

function start(path: string, showHidden: boolean, rec: Rec) {
  if (rec.stream || rec.asked) return;
  rec.asked = true;
  const t0 = performance.now();
  const cur = rec.sig[0]();
  if (cur.phase === "idle") patch(rec, { phase: "cache", startedAt: t0 });

  let first = false;
  const { id, done } = transport.stream(
    "list",
    { id: `list:${keyOf(path, showHidden)}:${Math.random().toString(36).slice(2, 8)}`, path, showHidden },
    (frame) => {
      if (!first) {
        first = true;
        const ttfb = performance.now() - t0;
        patch(rec, { ttfbMs: ttfb });
        metrics.push("list.ttfb", ttfb);
        // The view keeps the skeleton out of the first paint for a 40 ms grace
        // window, so a fast folder shows nothing at all — no flash.
        if (!rec.sig[0]().entries.length && frame.ev !== "done") {
          patch(rec, { phase: "streaming" });
        }
      }
      if (frame.ev === "cached") {
        const l = rec.sig[0]();
        if (!l.entries.length || l.fromCache) {
          const entries = frame.entries as Entry[];
          patch(rec, {
            entries,
            total: entries.length,
            fromCache: true,
            cacheValid: !!frame.valid,
          });
        }
      } else if (frame.ev === "entries") {
        const l = rec.sig[0]();
        // Fresh rows replace the cached guess rather than appending to it.
        const base = l.fromCache ? [] : l.entries;
        const entries = base.concat(frame.entries as Entry[]);
        patch(rec, {
          entries,
          total: frame.n ?? entries.length,
          phase: "streaming",
          fromCache: false,
          rev: l.rev + 1,
        });
      } else if (frame.ev === "done") {
        const l = rec.sig[0]();
        patch(rec, {
          phase: "done",
          total: frame.n ?? l.entries.length,
          scanMs: frame.ms,
          fromCache: false,
          cacheValid: true,
          rev: l.rev + 1,
        });
        metrics.push("list.scan", frame.ms ?? 0);
      }
    }
  );
  rec.stream = { id, done };
  done
    .then(() => {
      const l = rec.sig[0]();
      if (l.phase !== "done" && l.entries.length) patch(rec, { phase: "done" });
    })
    .catch((e: Error) => {
      if (!rec.sig[0]().entries.length) patch(rec, { phase: "error", error: e.message });
    })
    .finally(() => {
      rec.stream = undefined;
    });
}

/**
 * Reactive listing for a path. First call creates the record and starts the
 * stream; subsequent calls with the same key share it (that is the cache hit).
 */
export function listingFor(path: string, showHidden = false): Accessor<Listing> {
  const rec = recFor(path, showHidden);
  start(path, showHidden, rec);
  return rec.sig[0];
}

/** Start (or reuse) a scan without subscribing — hover/viewport/idle prefetch. */
export function warm(path: string, showHidden = false) {
  if (!path) return;
  const key = keyOf(path, showHidden);
  const existing = records.get(key);
  const l = existing?.sig[0]();
  if (l && (l.phase === "done" || l.entries.length)) {
    touch(key);
    return;
  }
  if (existing?.stream) return;
  const rec = recFor(path, showHidden);
  metrics.record("prefetch.issued", 1);
  start(path, showHidden, rec);
}

/** Non-reactive peek — used by pane APIs and the status bar. */
export function peek(path: string, showHidden = false): Listing | undefined {
  return records.get(keyOf(path, showHidden))?.sig[0]();
}

/** Drop a cached folder so the next visit rescans (after a mutation). */
export function invalidate(path: string) {
  for (const [key, rec] of [...records]) {
    if (key.endsWith(`:${path}`)) {
      rec.sig[1]((prev) => ({ ...prev, phase: "idle", entries: [], rev: prev.rev + 1 }));
      records.delete(key);
      lru.splice(lru.indexOf(key), 1);
    }
  }
  setRev((v) => v + 1);
}

/** Force a rescan of a path in place (keeps rows visible while it runs). */
export function rescan(path: string, showHidden = false) {
  const rec = recFor(path, showHidden);
  rec.asked = false;
  rec.stream = undefined;
  start(path, showHidden, rec);
}
