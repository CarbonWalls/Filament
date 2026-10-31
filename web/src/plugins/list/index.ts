import type { PluginContext } from "../../core/types";

/**
 * List view plugin.
 *
 * Proof of the architecture: this is the primary way people look at a folder,
 * and it is not in the shell — it is registered, code-split and replaceable.
 */
export default {
  id: "list-view",
  name: "List view",
  activate(ctx: PluginContext) {
    ctx.registerView({
      id: "list",
      title: "Files",
      kind: "pane",
      load: () => import("./List"),
    });

    ctx.registerCommand({
      id: "view.list",
      title: "View: list",
      key: "mod+1",
      group: "View",
      run: (c) => {
        const pane = c.focusedPane;
        if (pane) pane.setView("list");
      },
    });

    ctx.registerCommand({
      id: "list.showHidden",
      title: "Toggle hidden files",
      key: "mod+shift+.",
      group: "View",
      run: (c) => {
        const pane = c.focusedPane;
        if (pane) pane.setShowHidden(!pane.showHidden());
      },
    });

    ctx.registerCommand({
      id: "list.refresh",
      title: "Refresh folder",
      key: "mod+r",
      group: "File",
      run: (c) => c.focusedPane?.refresh(),
    });
  },
};
