import type { PluginContext } from "../../../core/types";

export async function activate(ctx: PluginContext) {
  ctx.registerTheme({ id: "slate", title: "Slate", load: () => import("./theme.css") });
}

export default { id: "slate", name: "Slate theme", activate };
