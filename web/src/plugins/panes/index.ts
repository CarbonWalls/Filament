import type { PluginContext } from "../../core/types";

/**
 * Panes plugin: split / close / cycle / focus by number.
 * Layout is a core primitive; the *commands that drive it* are a plugin.
 */
export default {
  id: "panes",
  name: "Panes",
  activate(ctx: PluginContext) {
    const ws = () => ctx.workspace;

    const splitWith = (dir: "h" | "v", view?: string) => {
      const pane = ws().focused();
      if (!pane) return;
      ws().split(pane.id, dir, view ?? pane.view());
    };

    ctx.registerCommand({
      id: "pane.split.right",
      title: "Split right",
      key: "mod+alt+arrowright",
      group: "Panes",
      run: () => splitWith("h"),
    });
    ctx.registerCommand({
      id: "pane.split.down",
      title: "Split down",
      key: "mod+alt+arrowdown",
      group: "Panes",
      run: () => splitWith("v"),
    });
    ctx.registerCommand({
      id: "pane.split.preview",
      title: "Split with preview",
      key: "mod+shift+p",
      group: "Panes",
      run: () => splitWith("h", "preview"),
    });
    ctx.registerCommand({
      id: "pane.close",
      title: "Close pane",
      key: "mod+w",
      group: "Panes",
      run: () => {
        const pane = ws().focused();
        if (pane) ws().close(pane.id);
      },
    });
    ctx.registerCommand({
      id: "pane.cycle",
      title: "Focus next pane",
      key: "tab",
      group: "Panes",
      run: () => {
        const panes = ws().panes();
        if (panes.length < 2) return;
        const i = panes.findIndex((p) => p.id === ws().focusedId());
        ws().focus(panes[(i + 1) % panes.length].id, { persistTab: true });
      },
    });
    ctx.registerCommand({
      id: "pane.swapView",
      title: "Switch pane view (list ↔ grid)",
      key: "mod+3",
      group: "Panes",
      run: () => {
        const pane = ws().focused();
        if (!pane) return;
        pane.setView(pane.view() === "list" ? "grid" : "list");
      },
    });

    for (let n = 1; n <= 4; n++) {
      ctx.registerCommand({
        id: `pane.focus.${n}`,
        title: `Focus pane ${n}`,
        key: `mod+alt+${n}`,
        group: "Panes",
        run: () => {
          const panes = ws().panes();
          const target = panes[n - 1];
          if (target) ws().focus(target.id, { persistTab: true });
        },
      });
    }
  },
};
