import { createSignal, onCleanup } from "solid-js";
import { reducedMotion } from "./settings";

/**
 * Motion rules, enforced in one place.
 *
 * The latency table is the contract:
 *   < 50 ms     → nothing. Just paint. (Animating here feels slower.)
 *   50–200 ms   → skeleton → content crossfade, 120 ms ease-out
 *   200–500 ms  → skeleton + shimmer
 *   > 500 ms    → skeleton + inline progress + cancel
 *   error       → 120 ms horizontal shake + toast
 *
 * Nothing here ever *delays* content: `useGrace` decides whether the skeleton
 * is allowed to appear at all, it never holds data back.
 */

const FLIP_MS = 160;

export const MOTION = {
  crossfade: 120,
  swap: 160,
  slide: 180,
  staggerStep: 22,
  staggerMax: 8,
};

/** Latency bucket for a completed wait. */
export function latencyTier(ms: number): "instant" | "crossfade" | "shimmer" | "progress" {
  if (ms < 50) return "instant";
  if (ms < 200) return "crossfade";
  if (ms < 500) return "shimmer";
  return "progress";
}

/**
 * Debug override for the grace window. Used by the screenshot harness to make
 * the skeleton observable on a fast local disk — it never runs in production.
 */
let graceOverride: number | undefined;
export function setGraceOverride(ms: number | undefined) {
  graceOverride = ms;
}

/**
 * True once `ms` has elapsed. Reset by calling the returned `reset()`.
 * Views use this to keep the skeleton out of the first paint for fast folders.
 */
export function useGrace(ms = 40) {
  ms = graceOverride ?? ms;
  const [elapsed, setElapsed] = createSignal(false);
  let timer: number | undefined;
  const arm = () => {
    setElapsed(false);
    clearTimeout(timer);
    timer = setTimeout(() => setElapsed(true), ms) as unknown as number;
  };
  arm();
  onCleanup(() => clearTimeout(timer));
  return { elapsed, reset: arm };
}

/**
 * A coarse ticker (default 100ms) used while a listing is pending, so the
 * latency tier can be re-evaluated as the wait grows — that's how a 200ms wait
 * upgrades itself from "no indicator" to shimmer to a progress bar.
 */
export function useTicker(ms = 100) {
  const [t, setT] = createSignal(0);
  const id = setInterval(() => setT((v) => v + 1), ms);
  onCleanup(() => clearInterval(id));
  return t;
}

/** Staggered entrance delay capped at staggerMax rows. */
export function staggerDelay(index: number): number {
  if (reducedMotion()) return 0;
  return Math.min(index, MOTION.staggerMax) * MOTION.staggerStep;
}

/** Direction-aware slide class for a pane swap. */
export function slideClass(direction: 1 | -1 | 0): string {
  if (reducedMotion() || direction === 0) return "swap-fade";
  return direction > 0 ? "swap-slide-forward" : "swap-slide-back";
}

/**
 * FLIP: capture rects before a DOM change, apply transforms after it, and let
 * the compositor animate back to zero. Used when a watched folder patches rows
 * in place instead of refetching.
 */
export function captureRects(root: ParentNode, selector: string): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const key = el.dataset.key;
    if (key) map.set(key, el.getBoundingClientRect());
  });
  return map;
}

export function playFlip(
  root: ParentNode,
  selector: string,
  before: Map<string, DOMRect>,
  duration = FLIP_MS
) {
  if (reducedMotion()) return;
  root.querySelectorAll<HTMLElement>(selector).forEach((el) => {
    const key = el.dataset.key;
    if (!key) return;
    const prev = before.get(key);
    const next = el.getBoundingClientRect();
    if (!prev) {
      // New row: fade + rise.
      el.animate(
        [
          { opacity: 0, transform: "translateY(4px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration, easing: "cubic-bezier(.2,.8,.2,1)" }
      );
      return;
    }
    const dy = prev.top - next.top;
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
  });
}

/** 120 ms horizontal shake for errors. */
export function shake(el: HTMLElement) {
  if (reducedMotion()) return;
  el.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(3px)" },
      { transform: "translateX(-2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 120, easing: "ease-out" }
  );
}

/** Cross-fade the outgoing content into the incoming content. */
export function crossfade(el: HTMLElement, duration = MOTION.crossfade) {
  if (reducedMotion()) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration,
    easing: "cubic-bezier(.2,.8,.2,1)",
  });
}

/**
 * Wrap a navigation in the View Transitions API when available, falling back
 * to a plain crossfade applied by the caller.
 */
export function withViewTransition(fn: () => void, enabled: boolean): (() => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (enabled && !reducedMotion() && typeof doc.startViewTransition === "function") {
    return () => doc.startViewTransition!(fn);
  }
  return fn;
}

/** Idle scheduling that works with or without requestIdleCallback. */
export function onIdle(fn: () => void, timeout = 1200) {
  const ric = (window as any).requestIdleCallback as
    | ((cb: () => void, o?: { timeout: number }) => number)
    | undefined;
  if (ric) return ric(fn, { timeout });
  return setTimeout(fn, 200) as unknown as number;
}
