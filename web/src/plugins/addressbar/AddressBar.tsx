import { For, Show, createMemo, createSignal } from "solid-js";
import type { WorkspaceApi } from "../../core/types";
import { crumbs } from "../../core/workspace";
import { Icon } from "../../icons";

/**
 * Address bar + navigation cluster — a plugin.
 *
 * Clicking the (truncated) path switches to edit mode; the breadcrumb shows
 * the full path without ever wrapping, and archive paths render as
 * `kit.zip › src › util` because the virtual FS is just another path.
 */
export default function AddressBar(props: { workspace: WorkspaceApi }) {
  /**
   * The bar follows the focused pane, but a bound pane (a preview with no
   * folder of its own) hands the bar back to the pane it follows — otherwise
   * the location would read "/" while the user is looking at a folder.
   */
  const pane = () => {
    const focused = props.workspace.focused();
    if (!focused) return undefined;
    if (focused.path()) return focused;
    const src = focused.props()?.source;
    if (src) {
      const id = src.replace(/^\$/, "").split(".")[0];
      const owner = id === "focused" ? undefined : props.workspace.pane(id);
      if (owner?.path()) return owner;
    }
    return props.workspace.panes().find((p) => p.path()) ?? focused;
  };
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");
  let input: HTMLInputElement | undefined;

  const path = () => pane()?.path() ?? "";
  const parts = createMemo(() => crumbs(path()));

  const startEdit = () => {
    setDraft(path());
    setEditing(true);
    queueMicrotask(() => {
      input?.focus();
      input?.select();
    });
  };

  const commit = () => {
    const v = draft().trim();
    setEditing(false);
    if (!v || !pane()) return;
    props.workspace.pane(pane()!.id)?.navigate(v);
  };

  const canBack = () => {
    const p = pane();
    return !!p && props.workspace.historyState(p.id).index > 0;
  };
  const canForward = () => {
    const p = pane();
    if (!p) return false;
    const h = props.workspace.historyState(p.id);
    return h.index < h.length - 1;
  };

  return (
    <div style={{ display: "flex", "align-items": "center", gap: "4px", "min-width": 0, flex: 1, "justify-content": "flex-start" }}>
      <button class="icon-btn" title="Back (Alt+←)" aria-label="Back" onClick={() => pane() && props.workspace.goBack(pane()!.id)} disabled={!canBack()}>
        <Icon name="arrowLeft" />
      </button>
      <button class="icon-btn" title="Forward (Alt+→)" aria-label="Forward" onClick={() => pane() && props.workspace.goForward(pane()!.id)} disabled={!canForward()}>
        <Icon name="arrowRight" />
      </button>
      <button
        class="icon-btn"
        title="Up (Backspace)"
        aria-label="Up"
        onClick={() => {
          const p = pane();
          if (!p) return;
          const parent = path().includes("!/") ? path().split("!/")[0] || "/" : path().replace(/\/[^/]+\/?$/, "") || "/";
          props.workspace.pane(p.id)?.navigate(parent);
        }}
      >
        <Icon name="arrowUp" />
      </button>

      <div class="address" title={path()}>
        <Show
          when={!editing()}
          fallback={
            <input
              ref={input}
              class="address-edit"
              value={draft()}
              spellcheck={false}
              autocomplete="off"
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          }
        >
          <For each={parts().slice(-6)}>
            {(c, i) => (
              <>
                <Show when={i() > 0 || parts().length > 6}>
                  <span class="crumb-sep">›</span>
                </Show>
                <button
                  class="crumb"
                  classList={{ current: i() === parts().slice(-6).length - 1 }}
                  onClick={() => pane() && props.workspace.pane(pane()!.id)?.navigate(c.path)}
                  onDblClick={startEdit}
                >
                  {c.label}
                </button>
              </>
            )}
          </For>
          <Show when={parts().length === 0}>
            <span class="crumb-sep" />
            <button class="crumb current" onClick={startEdit}>
              /
            </button>
          </Show>
        </Show>
      </div>

      <button class="icon-btn" title="Edit path (Ctrl/Cmd+L)" aria-label="Edit path" onClick={startEdit}>
        <Icon name="edit" />
      </button>
    </div>
  );
}
