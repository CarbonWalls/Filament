import type { PluginContext } from "../../core/types";

/** Keyboard shortcut sheet. The `?` binding belongs to this plugin. */
export default {
  id: "keys",
  name: "Keyboard help",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("topbar-right", () => import("./HelpButton"));
    ctx.registerCommand({
      id: "keys.help",
      title: "Keyboard shortcuts",
      key: "mod+/",
      group: "Help",
      run: async () => {
        const mod = await import("./KeysHelp");
        // The overlay toggles on `?`; dispatch it so there is one code path.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
        void mod;
      },
    });
  },
};
