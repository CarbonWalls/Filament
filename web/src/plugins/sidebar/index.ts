import type { PluginContext } from "../../core/types";

export default {
  id: "sidebar",
  name: "Sidebar",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("sidebar", () => import("./Sidebar"));
    ctx.registerCommand({
      id: "sidebar.toggle",
      title: "Toggle sidebar",
      key: "mod+b",
      group: "View",
      run: () => {
        const app = document.querySelector<HTMLElement>(".app");
        if (!app) return;
        // Below 760px the sidebar is a drawer; above it, it is simply hidden.
        if (getComputedStyle(document.querySelector(".drawer-toggle")!).display !== "none") {
          app.dataset.drawer = app.dataset.drawer === "open" ? "closed" : "open";
        } else {
          const sb = document.querySelector<HTMLElement>(".sidebar")!;
          const hidden = sb.style.display === "none";
          sb.style.display = hidden ? "" : "none";
        }
      },
    });
  },
};
