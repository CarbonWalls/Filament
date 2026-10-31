import type { PluginContext } from "../../core/types";

/** Navigation + address bar commands. Owned by the address-bar plugin. */
export default {
  id: "addressbar",
  name: "Address bar",
  activate(ctx: PluginContext) {
    ctx.registerChromeSlot("topbar-center", () => import("./AddressBar"));

    const ws = ctx.workspace;

    ctx.registerCommand({
      id: "nav.back",
      title: "Go back",
      key: "alt+arrowleft",
      group: "Navigation",
      run: (c) => {
        const id = c.focusedPane?.id;
        if (id) ws.goBack(id);
      },
    });
    ctx.registerCommand({
      id: "nav.forward",
      title: "Go forward",
      key: "alt+arrowright",
      group: "Navigation",
      run: (c) => {
        const id = c.focusedPane?.id;
        if (id) ws.goForward(id);
      },
    });
    ctx.registerCommand({
      id: "nav.up",
      title: "Go to parent folder",
      group: "Navigation",
      run: (c) => {
        const pane = c.focusedPane;
        if (!pane) return;
        const p = pane.path();
        const parent = p.includes("!/")
          ? p.split("!/")[0] || "/"
          : p.replace(/\/[^/]+\/?$/, "") || "/";
        if (parent !== p) pane.navigate(parent, { direction: -1 });
      },
    });
    ctx.registerCommand({
      id: "nav.home",
      title: "Go home",
      group: "Navigation",
      run: async (c) => {
        const pane = c.focusedPane;
        if (!pane) return;
        const { transport } = await import("../../core/transport");
        const r = await transport.request<{ home: string }>("hello");
        pane.navigate(r.home);
      },
    });
    ctx.registerCommand({
      id: "nav.editPath",
      title: "Edit location",
      key: "mod+l",
      group: "Navigation",
      run: () => {
        const btn = document.querySelectorAll<HTMLElement>(".address + .icon-btn, .topbar-center .icon-btn");
        btn[btn.length - 1]?.click();
      },
    });
  },
};
