import type { PluginContext } from "../../core/types";

/** Global search plugin: a pane view plus the top-bar filter for the focused pane. */
export default {
  id: "search",
  name: "Search",
  activate(ctx: PluginContext) {
    ctx.registerView({
      id: "search",
      title: "Search",
      kind: "pane",
      load: () => import("./SearchView"),
    });

    ctx.registerChromeSlot("topbar-right", () => import("./FilterBox"));

    ctx.registerCommand({
      id: "search.focus",
      title: "Search in this folder",
      key: "mod+f",
      group: "Search",
      run: () => {
        document.querySelector<HTMLInputElement>(".search-field input")?.focus();
      },
    });

    ctx.registerCommand({
      id: "search.openPane",
      title: "Open search pane",
      group: "Search",
      run: (c) => {
        const pane = c.focusedPane;
        if (pane) ctx.workspace.split(pane.id, "v", "search");
      },
    });
  },
};
