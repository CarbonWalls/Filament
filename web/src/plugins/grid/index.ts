import type { PluginContext } from "../../core/types";

export default {
  id: "grid-view",
  name: "Grid view",
  activate(ctx: PluginContext) {
    ctx.registerView({
      id: "grid",
      title: "Gallery",
      kind: "pane",
      load: () => import("./Grid"),
    });
    ctx.registerCommand({
      id: "view.grid",
      title: "View: gallery grid",
      key: "mod+2",
      group: "View",
      run: (c) => c.focusedPane?.setView("grid"),
    });
  },
};
