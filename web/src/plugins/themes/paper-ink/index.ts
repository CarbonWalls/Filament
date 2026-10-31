import type { PluginContext } from "../../../core/types";

export async function activate(ctx: PluginContext) {
  ctx.registerTheme({ id: "paper-ink", title: "Paper & Ink", load: () => import("./theme.css") });
}

export default { id: "paper-ink", name: "Paper & Ink theme", activate };
