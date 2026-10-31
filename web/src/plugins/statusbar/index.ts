import type { PluginContext } from "../../core/types";

export default {
  id: "statusbar",
  name: "Status bar",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("status", () => import("./StatusBar"));
  },
};
