import type { PluginContext } from "../../core/types";
import { fileUrl } from "../../core/transport";
import { copyText, fmtBytesExact, fmtDate, fmtRelative } from "../../core/viewkit";
import { baseName } from "../../core/workspace";

/**
 * Inspector: property/URL actions for the selection, contributed to the context
 * menu. (The preview plugin renders the visual side.)
 */
export default {
  id: "inspector",
  name: "Inspector",
  activate(ctx: PluginContext) {
    ctx.registerContextMenuItem({
      id: "properties",
      label: "Copy properties",
      when: (s) => s.isSingle && !s.isDir,
      run: async (s) => {
        const entry = s.entries[0];
        const target = s.paths[0];
        if (!entry || !target) return;
        const lines = [
          `name     ${entry.name}`,
          `path     ${target}`,
          `size     ${fmtBytesExact(entry.size)}`,
          `modified ${fmtDate(entry.mtime)} (${fmtRelative(entry.mtime)})`,
          `type     ${entry.ext ?? "unknown"}`,
        ];
        await copyText(lines.join("\n"));
        ctx.toasts.show({ title: "Properties copied", detail: entry.name });
      },
    });

    ctx.registerContextMenuItem({
      id: "raw-url",
      label: "Copy raw file URL",
      when: (s) => s.isSingle && !s.isDir,
      run: async (s) => {
        const target = s.paths[0];
        if (!target) return;
        const url = new URL(fileUrl(target), location.origin).toString();
        await copyText(url);
        ctx.toasts.show({ title: "URL copied", detail: baseName(target) });
      },
    });

    ctx.registerContextMenuItem({
      id: "reveal",
      label: "Select in parent folder",
      when: (s) => s.isSingle,
      run: (s) => {
        const target = s.paths[0];
        if (!target) return;
        const parent = target.replace(/\/[^/]+$/, "") || "/";
        const focused = ctx.workspace.focused();
        if (!focused) return;
        ctx.workspace.navigate(focused.id, parent);
        setTimeout(() => focused.setSelection([target]), 180);
      },
    });
  },
};
