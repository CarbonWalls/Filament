import type { PluginContext } from "../../core/types";

/**
 * Preview plugin: the "inspector" side of a split.
 *
 * `open.preview` either focuses an existing preview pane bound to this pane,
 * or splits one in — with the binding `$<focusedPaneId>` so the two panes are
 * connected without either knowing about the other.
 */
export default {
  id: "preview",
  name: "Preview",
  activate(ctx: PluginContext) {
    ctx.registerView({
      id: "preview",
      title: "Preview",
      kind: "pane",
      load: () => import("./Preview"),
    });

    ctx.registerCommand({
      id: "open.preview",
      title: "Preview selection",
      key: "space",
      group: "View",
      run: (c) => {
        const pane = c.focusedPane;
        if (!pane) return;
        const panes = ctx.workspace.panes();
        const bound = panes.find((p) => p.view() === "preview" && p.props()?.source === `$${pane.id}`);
        if (bound) {
          ctx.workspace.focus(bound.id);
          return;
        }
        const dir = panes.length > 1 && window.innerWidth > 1100 ? "h" : "h";
        ctx.workspace.split(pane.id, dir, "preview");
      },
    });

    ctx.registerCommand({
      id: "preview.toggle",
      title: "Toggle preview pane",
      key: "mod+i",
      group: "View",
      run: (c) => {
        const pane = c.focusedPane;
        if (!pane) return;
        const panes = ctx.workspace.panes();
        const existing = panes.find((p) => p.view() === "preview");
        if (existing) {
          ctx.workspace.close(existing.id);
          return;
        }
        ctx.workspace.split(pane.id, "h", "preview");
      },
    });
  },
};
