import type { PluginContext } from "../../../core/types";

/** Each theme is a plugin that ships a stylesheet and one registration. */
export async function activate(ctx: PluginContext) {
  ctx.registerTheme({ id: "ember", title: "Ember", load: () => import("./theme.css").then((m) => m) });
}

export default { id: "ember", name: "Ember theme", activate };
