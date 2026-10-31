import type { PluginContext } from "../../core/types";
import { transport } from "../../core/transport";
import { toasts } from "../../core/registry";
import { baseName, join, parentOf } from "../../core/workspace";
import { copyText } from "../../core/viewkit";
import { metrics } from "../../core/metrics";

/**
 * File context menu + file commands.
 *
 * This plugin owns the *default* items; other plugins append theirs (see the
 * search / inspector / plugins plugins for examples). The shell only renders
 * whatever the registry collected.
 */
export default {
  id: "contextmenu",
  name: "File actions",
  activate(ctx: PluginContext) {
    const runOp = async (op: string, params: Record<string, unknown>, okTitle: string) => {
      try {
        const res = await transport.request<{ msg: string }>("op", { op, ...params });
        toasts.show({ title: okTitle, detail: res.msg });
        metrics.record(`op.${op}`, 1);
        const focused = ctx.workspace.focused();
        if (focused) ctx.workspace.invalidatePane(focused.id);
        return true;
      } catch (e) {
        toasts.show({ title: `${op} failed`, detail: String(e), kind: "error" });
        return false;
      }
    };

    const openInNewPane = (sel: { paths: string[] }) => {
      const target = sel.paths[0];
      if (!target) return;
      const focused = ctx.workspace.focused();
      if (!focused) return;
      ctx.workspace.split(focused.id, "h", "list");
      const panes = ctx.workspace.panes();
      const fresh = panes[panes.length - 1];
      const dir = target.includes(".") && !target.endsWith("/") ? parentOf(target) : target;
      if (dir) ctx.workspace.navigate(fresh.id, dir);
    };

    ctx.registerContextMenuItem({
      id: "open",
      label: "Open",
      key: "↵",
      when: (s) => s.isSingle,
      run: (s, pane) => {
        const target = s.paths[0];
        if (!target) return;
        const entry = s.entries[0];
        if (entry && entry.kind !== 1) {
          pane.setSelection([target]);
          void import("../preview/index").then(() => {
            const cmd = (window as any).__filament?.registry?.commands?.get("open.preview");
            cmd?.run(null);
          });
          return;
        }
        ctx.workspace.navigate(pane.id, target, { direction: 1 });
      },
    });

    ctx.registerContextMenuItem({
      id: "open-new-pane",
      label: "Open in new pane",
      when: (s) => s.isSingle,
      run: (s) => openInNewPane(s),
    });

    ctx.registerContextMenuItem({ id: "sep1", label: "", separator: true, run: () => {} });

    ctx.registerContextMenuItem({
      id: "rename",
      label: "Rename…",
      key: "F2",
      when: (s) => s.isSingle,
      run: (s, pane) => {
        const target = s.paths[0];
        if (!target) return;
        void import("../../ui/overlays").then(({ openPrompt }) => {
          openPrompt({
            title: "Rename",
            detail: s.panePath,
            value: baseName(target),
            bare: true,
            confirmLabel: "Rename",
            onSubmit: async (value) => {
              await runOp("rename", { src: [target], name: value }, "Renamed");
              pane.refresh();
            },
          });
        });
      },
    });

    ctx.registerContextMenuItem({
      id: "duplicate",
      label: "Duplicate",
      when: (s) => s.isSingle,
      run: async (s, pane) => {
        const target = s.paths[0];
        if (!target) return;
        const dir = parentOf(target);
        if (!dir) return;
        await runOp("copy", { src: [target], dest: dir }, "Duplicated");
        pane.refresh();
      },
    });

    ctx.registerContextMenuItem({
      id: "new-folder",
      label: "New folder",
      key: "mod+shift+n",
      when: (s) => !!s.panePath,
      run: async (s, pane) => {
        const { openPrompt } = await import("../../ui/overlays");
        openPrompt({
          title: "New folder",
          detail: s.panePath,
          value: "untitled folder",
          bare: true,
          confirmLabel: "Create",
          onSubmit: async (value) => {
            await runOp("mkdir", { dest: s.panePath, name: value }, "Created folder");
            pane.refresh();
          },
        });
      },
    });

    ctx.registerContextMenuItem({
      id: "new-file",
      label: "New file",
      when: (s) => !!s.panePath,
      run: async (s, pane) => {
        const { openPrompt } = await import("../../ui/overlays");
        openPrompt({
          title: "New file",
          detail: s.panePath,
          value: "untitled.txt",
          bare: true,
          confirmLabel: "Create",
          onSubmit: async (value) => {
            await runOp("newfile", { dest: s.panePath, name: value }, "Created file");
            pane.refresh();
          },
        });
      },
    });

    ctx.registerContextMenuItem({ id: "sep2", label: "", separator: true, run: () => {} });

    ctx.registerContextMenuItem({
      id: "copy-path",
      label: "Copy path",
      when: (s) => s.paths.length > 0,
      run: async (s) => {
        const ok = await copyText(s.paths.join("\n"));
        toasts.show({ title: ok ? "Copied path" : "Copy blocked", detail: s.paths[0], kind: ok ? "info" : "warn" });
      },
    });

    ctx.registerContextMenuItem({
      id: "move-to",
      label: "Move to other pane…",
      when: (s) => s.paths.length > 0 && ctx.workspace.panes().length > 1,
      run: async (s) => {
        const focusedId = ctx.workspace.focusedId();
        const other = ctx.workspace.panes().find((p) => p.id !== focusedId);
        if (!other?.path()) return;
        await runOp("move", { src: s.paths, dest: other.path() }, "Moved");
      },
    });

    ctx.registerContextMenuItem({
      id: "copy-to",
      label: "Copy to other pane…",
      when: (s) => s.paths.length > 0 && ctx.workspace.panes().length > 1,
      run: async (s) => {
        const focusedId = ctx.workspace.focusedId();
        const other = ctx.workspace.panes().find((p) => p.id !== focusedId);
        if (!other?.path()) return;
        await runOp("copy", { src: s.paths, dest: other.path() }, "Copied");
      },
    });

    ctx.registerContextMenuItem({ id: "sep3", label: "", separator: true, run: () => {} });

    ctx.registerContextMenuItem({
      id: "delete",
      label: "Move to trash",
      key: "⌫",
      danger: true,
      when: (s) => s.paths.length > 0,
      run: async (s, pane) => {
        const { openPrompt } = await import("../../ui/overlays");
        openPrompt({
          title: `Move ${s.paths.length} item${s.paths.length > 1 ? "s" : ""} to trash?`,
          detail: s.paths.slice(0, 3).map(baseName).join(", ") + (s.paths.length > 3 ? ` +${s.paths.length - 3} more` : ""),
          confirmLabel: "Move to trash",
          danger: true,
          bare: false,
          onSubmit: async () => {
            await runOp("delete", { src: s.paths }, "Moved to trash");
            pane.refresh();
          },
        });
      },
    });

    // ---- commands ---------------------------------------------------------

    ctx.registerCommand({
      id: "file.newFolder",
      title: "New folder…",
      key: "mod+shift+n",
      group: "File",
      run: async (c) => {
        const pane = c.focusedPane;
        if (!pane) return;
        const { openPrompt } = await import("../../ui/overlays");
        openPrompt({
          title: "New folder",
          detail: pane.path(),
          value: "untitled folder",
          bare: true,
          confirmLabel: "Create",
          onSubmit: async (value) => {
            await runOp("mkdir", { dest: pane.path(), name: value }, "Created folder");
            pane.refresh();
          },
        });
      },
    });

    ctx.registerCommand({
      id: "file.rename",
      title: "Rename…",
      key: "F2",
      group: "File",
      when: (c) => (c.focusedPane?.selection().length ?? 0) === 1,
      run: async (c) => {
        const pane = c.focusedPane;
        const target = pane?.selection()[0];
        if (!pane || !target) return;
        const { openPrompt } = await import("../../ui/overlays");
        openPrompt({
          title: "Rename",
          value: baseName(target),
          bare: true,
          confirmLabel: "Rename",
          onSubmit: async (value) => {
            await runOp("rename", { src: [target], name: value }, "Renamed");
            pane.refresh();
          },
        });
      },
    });

    ctx.registerCommand({
      id: "file.delete",
      title: "Move to trash",
      key: "Delete",
      group: "File",
      when: (c) => (c.focusedPane?.selection().length ?? 0) > 0,
      run: async (c) => {
        const pane = c.focusedPane;
        const paths = pane?.selection() ?? [];
        if (!pane || !paths.length) return;
        await runOp("delete", { src: paths }, "Moved to trash");
        pane.refresh();
      },
    });

    ctx.registerCommand({
      id: "file.copyPath",
      title: "Copy path",
      key: "mod+shift+c",
      group: "File",
      run: async (c) => {
        const paths = c.focusedPane?.selection() ?? [];
        if (!paths.length) return;
        const ok = await copyText(paths.join("\n"));
        toasts.show({ title: ok ? "Copied" : "Copy blocked", detail: paths[0] });
      },
    });

    ctx.registerCommand({
      id: "file.openInNewPane",
      title: "Open in new pane",
      group: "File",
      run: (c) => {
        const paths = c.focusedPane?.selection() ?? [];
        if (paths[0]) openInNewPane({ paths });
      },
    });

    ctx.registerCommand({
      id: "file.newWindow",
      title: "Open folder in a new browser window",
      group: "File",
      run: (c) => {
        const p = c.focusedPane?.path();
        if (p) window.open(`#${p}`, "_blank", "noopener");
      },
    });
  },
};

/** Re-exported so other plugins can build the same op request. */
export { join };
