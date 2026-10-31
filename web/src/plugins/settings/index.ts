import type { PluginContext } from "../../core/types";

export default {
  id: "settings",
  name: "Settings",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("topbar-right", () => import("./SettingsPanel"));
    ctx.registerCommand({
      id: "settings.open",
      title: "Open settings",
      key: "mod+,",
      group: "Help",
      run: () => {
        const btn = [...document.querySelectorAll<HTMLElement>(".topbar-right .icon-btn")].pop();
        btn?.click();
      },
    });
  },
};
