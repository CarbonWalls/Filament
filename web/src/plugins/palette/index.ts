import type { PluginContext } from "../../core/types";

/**
 * Command palette plugin.
 *
 * Note what the shell does *not* do: it does not own the palette, its
 * keybinding, or the Ctrl/Cmd-K shortcut. All three live here.
 */
export default {
  id: "palette",
  name: "Command palette",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("topbar-right", () => import("./PaletteButton"));

    ctx.registerCommand({
      id: "palette.open",
      title: "Show all commands",
      key: "mod+k",
      group: "Navigation",
      run: async () => {
        const m = await import("./Palette");
        m.openPalette();
      },
    });

    ctx.registerCommand({
      id: "palette.search",
      title: "Search files…",
      key: "mod+shift+f",
      group: "Search",
      run: async () => {
        const m = await import("./Palette");
        m.openPalette();
      },
    });
  },
};
