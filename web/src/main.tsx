import { render } from "solid-js/web";
import "./style.css";
import { App } from "./ui/App";
import { installCore, registry, setBackendManifests, toasts } from "./core/registry";
import { createWorkspace } from "./core/workspace";
import { metrics } from "./core/metrics";
import { transport } from "./core/transport";
import { settings } from "./core/settings";

/**
 * Boot.
 *
 * Order matters for perceived speed:
 *   1. connect the socket (nothing renders without it, but the shell paints
 *      from cache either way),
 *   2. mount the shell,
 *   3. load plugins in parallel — they register themselves as they arrive.
 */
async function boot() {
  const root = document.getElementById("root")!;

  let home = "/";
  try {
    await transport.connect();
    const hello = await transport.request<{ home: string; plugins: any[] }>("hello");
    home = hello.home;
    setBackendManifests(hello.plugins ?? []);
  } catch (e) {
    toasts.show({ title: "Daemon unreachable", detail: String(e), kind: "error" });
  }

  const workspace = createWorkspace(home);

  installCore({
    workspace: workspace.api,
    context: () => ({
      workspace: workspace.api,
      focusedPane: workspace.api.focused(),
      plugins: {
        load: (id) => registry.load(id),
        loaded: () => registry.loadedList(),
        all: () =>
          [...registry.views.values()].reduce<{ id: string; views: string[]; commands: string[] }[]>(
            (acc, v) => {
              acc.push({ id: v.id, views: [v.id], commands: [] });
              return acc;
            },
            []
          ),
      },
      toasts,
    }),
  });

  // Theme plugin first so the first painted frame has the right palette.
  const boot = [
    settings.theme,
    "slate",
    "paper-ink",
    "sidebar",
    "addressbar",
    "list-view",
    "statusbar",
    "palette",
    "contextmenu",
    "panes",
    "keys",
    "preview",
    "grid-view",
    "search",
    "settings",
    "inspector",
    "perf",
  ].filter((v, i, a) => a.indexOf(v) === i);

  render(() => <App workspace={workspace} home={home} />, root);
  document.getElementById("boot")?.classList.add("hide");
  setTimeout(() => document.getElementById("boot")?.remove(), 200);

  // Plugins load in parallel and paint as they land.
  void registry.loadAll(boot);

  // Deep link / back-forward.
  window.addEventListener("hashchange", () => workspace.applyHash());
  workspace.applyHash();

  // Watch the focused folder for live patching.
  transport.subscribe((frame) => {
    if (frame.ev === "fsevent") {
      const focused = workspace.api.focused();
      if (!focused) return;
      const dir = focused.path();
      const paths: string[] = frame.paths ?? [];
      if (paths.some((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"))) {
        // Coalesce bursts: a build writing 200 files should cost one rescan.
        scheduleWatch(dir, focused.showHidden());
      }
    }
  });

  const watched = new Set<string>();
  setInterval(() => {
    const focused = workspace.api.focused();
    if (!focused) return;
    const p = focused.path();
    if (!p || watched.has(p)) return;
    watched.add(p);
    void transport.request("watch", { path: p }).catch(() => {});
  }, 800);

  // Expose a small debug surface (metrics, hit rate) for demos and e2e.
  (window as any).__filament = {
    metrics,
    workspace: workspace.api,
    registry,
    reload: () => workspace.invalidatePane(workspace.focusedId()),
    nav: (p: string) => workspace.navigate(workspace.focusedId(), p),
    split: (dir: "h" | "v", view?: string) => {
      const pane = workspace.api.focused();
      if (pane) workspace.api.split(pane.id, dir, view);
    },
    // Screenshot/debug hook: widen the skeleton grace window so the loading
    // state is observable on a fast disk. Never used in normal operation.
    slowGrace: async (ms = 600) => {
      const { setGraceOverride } = await import("./core/anim");
      setGraceOverride(ms);
    },
    resetGrace: async () => {
      const { setGraceOverride } = await import("./core/anim");
      setGraceOverride(undefined);
    },
    // Debug-only: ask the daemon to slow listings down (requires --allow-debug)
    // so loading states can be exercised and photographed. Resolves with the
    // value the *daemon* applied, so a caller can wait for the ack instead of
    // hoping the setting landed.
    setSlow: (ms: number) =>
      transport
        .request<{ slowMs: number }>("debug.delay", { ms })
        .catch(() => ({ slowMs: -1 })),
    theme: (id: string) => {
      const el = document.documentElement;
      el.dataset.theme = id;
      void registry.themes.get(id)?.load();
    },
  };

  // Service worker: subsequent loads of the shell come from disk.
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

let watchTimer: number | undefined;
function scheduleWatch(dir: string, hidden: boolean) {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(async () => {
    const { rescan } = await import("./core/listings");
    rescan(dir, hidden);
    const { metrics } = await import("./core/metrics");
    metrics.record("watch.rescan", 1);
  }, 220) as unknown as number;
}

void boot();
