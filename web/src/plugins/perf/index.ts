import type { PluginContext } from "../../core/types";

export default {
  id: "perf",
  name: "Latency HUD",
  activate(ctx: PluginContext) {
    ctx.registerStatusItem({ id: "perf.hud", position: "right", order: 10, component: () => import("./PerfHud") });
    ctx.registerCommand({
      id: "perf.reset",
      title: "Reset latency metrics",
      group: "Help",
      run: () => ctx.metrics.reset?.(),
    });
    ctx.registerCommand({
      id: "perf.dump",
      title: "Copy latency metrics as JSON",
      group: "Help",
      run: async () => {
        const { copyText } = await import("../../core/viewkit");
        await copyText(JSON.stringify(ctx.metrics.snapshot(), null, 2));
        ctx.toasts.show({ title: "Metrics copied to clipboard" });
      },
    });
  },
};
