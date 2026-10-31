import { For, Show, Suspense, createMemo, createResource, onCleanup } from "solid-js";
import type { PaneApi } from "../core/types";
import { registry } from "../core/registry";
import type { Workspace } from "../core/workspace";
import { Icon } from "../icons";

/**
 * A pane: a chrome header plus whatever plugin view is mounted in the body.
 *
 * Views are resolved lazily through the registry. If the plugin that owns a
 * view hasn't been loaded yet, the pane shows a skeleton and the plugin is
 * fetched — the shell never imports a view directly.
 */

async function resolveView(viewId: string): Promise<{ default: any }> {
  const existing = registry.views.get(viewId);
  if (existing) return existing.load();
  // The view isn't registered yet: fetch the plugin that owns it (this is the
  // whole laziness story — views cost nothing until a pane asks for one).
  await registry.ensureView(viewId);
  const def = registry.views.get(viewId);
  if (!def) throw new Error(`no view registered as '${viewId}'`);
  return def.load();
}

export function Pane(props: { pane: PaneApi; workspace: Workspace; index: number }) {
  const ws = props.workspace;
  const viewId = () => props.pane.view();
  const [comp] = createResource(viewId, resolveView);
  const focused = createMemo(() => ws.focusedId() === props.pane.id);

  const header = registry.views.get(viewId())?.title ?? viewId();

  // Keyboard focus follows the pane, not the DOM.
  const onPointerDown = () => {
    if (!focused()) ws.focus(props.pane.id);
  };

  const phase = () => props.pane.phase();

  return (
    <section
      class="pane"
      classList={{ focused: focused() }}
      data-pane={props.pane.id}
      data-view={viewId()}
      onPointerDown={onPointerDown}
      aria-label={`pane ${props.index + 1}`}
    >
      <div class="pane-head">
        <span class="pane-title">{header}</span>
        <Show when={phase() === "streaming"}>
          <span class="chip hot">streaming</span>
        </Show>
        <Show when={phase() === "error"}>
          <span class="chip" style={{ color: "var(--danger)", "border-color": "var(--danger)" }}>
            error
          </span>
        </Show>
        <div class="pane-tools">
          <PaneTools pane={props.pane} />
        </div>
      </div>
      <div class="pane-body">
        <Suspense fallback={<div class="empty">loading view…</div>}>
          <Show when={comp()} keyed>
            {(mod) => {
              const View = (mod as any).default;
              return <View pane={props.pane} workspace={ws.api} />;
            }}
          </Show>
        </Suspense>
      </div>
    </section>
  );
}

function PaneTools(props: { pane: PaneApi }) {
  const wsRef = () => props.pane;
  return (
    <>
      <button
        class="icon-btn"
        style={{ width: "22px", height: "22px" }}
        title="Split right"
        onClick={() => {
          const ws = currentWorkspace;
          ws?.api.split(props.pane.id, "h", props.pane.view());
        }}
      >
        <Icon name="splitH" size={14} />
      </button>
      <button
        class="icon-btn"
        style={{ width: "22px", height: "22px" }}
        title="Split down"
        onClick={() => currentWorkspace?.api.split(wsRef().id, "v", props.pane.view())}
      >
        <Icon name="splitV" size={14} />
      </button>
    </>
  );
}

/** Set by LayoutTree so pane chrome can call workspace ops without prop drilling. */
export let currentWorkspace: Workspace | undefined;
export function setCurrentWorkspace(ws: Workspace) {
  currentWorkspace = ws;
}

/** Divider drag + recursive tree render. -------------------------------------------------- */

export function LayoutTree(props: { workspace: Workspace }) {
  setCurrentWorkspace(props.workspace);
  const leaves = createMemo(() => countLeaves(props.workspace.api.tree()));
  return (
    <div class="workspace-col" data-panes={leaves()}>
      <PaneTabs workspace={props.workspace} />
      <div class="workspace">
        <Node node={() => props.workspace.api.tree()} path={[]} workspace={props.workspace} />
      </div>
    </div>
  );
}

function countLeaves(node: any): number {
  if (node.type === "leaf") return 1;
  return countLeaves(node.a) + countLeaves(node.b);
}

function Node(props: { node: () => any; path: number[]; workspace: Workspace }) {
  const n = () => props.node();
  return (
    <Show when={n().type === "split"} fallback={<PaneLeaf path={props.path} workspace={props.workspace} node={props.node} />}>
      <SplitView node={props.node} path={props.path} workspace={props.workspace} />
    </Show>
  );
}

function PaneLeaf(props: { node: () => any; path: number[]; workspace: Workspace }) {
  const id = () => props.node().pane as string;
  const pane = createMemo(() => props.workspace.api.pane(id()));
  const index = createMemo(() => leafIndex(props.workspace, id()));
  return (
    <Show when={pane()}>
      {(p) => <Pane pane={p()} workspace={props.workspace} index={index()} />}
    </Show>
  );
}

function leafIndex(ws: Workspace, id: string): number {
  const ids = orderedPanes(ws.api.tree());
  return Math.max(0, ids.indexOf(id));
}

function orderedPanes(node: any): string[] {
  if (node.type === "leaf") return [node.pane];
  return [...orderedPanes(node.a), ...orderedPanes(node.b)];
}

function SplitView(props: { node: () => any; path: number[]; workspace: Workspace }) {
  const dir = () => props.node().dir as "h" | "v";
  const ratio = () => props.node().ratio as number;
  let container: HTMLDivElement | undefined;
  let frame = 0;

  const onPointerMove = (e: PointerEvent) => {
    if (!container) return;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = container!.getBoundingClientRect();
      const r =
        dir() === "h"
          ? (e.clientX - rect.left) / rect.width
          : (e.clientY - rect.top) / rect.height;
      props.workspace.api.setRatio(props.path, Math.min(0.88, Math.max(0.12, r)));
    });
  };

  const startDrag = (e: PointerEvent) => {
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    target.dataset.dragging = "true";
    const move = (ev: PointerEvent) => onPointerMove(ev);
    const up = () => {
      target.dataset.dragging = "false";
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      cancelAnimationFrame(frame);
      frame = 0;
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    onCleanup(up);
  };

  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.08 : 0.02;
    if (props.node().dir === "h" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      props.workspace.api.setRatio(props.path, ratio() + (e.key === "ArrowLeft" ? -step : step));
    }
    if (props.node().dir === "v" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      props.workspace.api.setRatio(props.path, ratio() + (e.key === "ArrowUp" ? -step : step));
    }
  };

  return (
    <div class="split" data-dir={dir()} ref={container} style={{ "--ratio": `${ratio()}` }}>
      <div class="split-a">
        <Node node={() => props.node().a} path={[...props.path, 0]} workspace={props.workspace} />
      </div>
      <div
        class="divider"
        role="separator"
        tabindex="0"
        aria-orientation={dir() === "h" ? "vertical" : "horizontal"}
        onPointerDown={startDrag}
        onKeyDown={onKey}
      />
      <div class="split-b">
        <Node node={() => props.node().b} path={[...props.path, 1]} workspace={props.workspace} />
      </div>
    </div>
  );
}

/** Mobile tab bar — same tree, just a different way to reach its leaves. */
function PaneTabs(props: { workspace: Workspace }) {
  const panes = createMemo(() => props.workspace.api.panes());
  return (
    <Show when={panes().length > 1}>
      <div class="pane-tabs">
        <For each={panes()}>
          {(p, i) => (
            <button
              data-active={props.workspace.focusedId() === p.id}
              onClick={() => {
                props.workspace.focus(p.id, { persistTab: true });
                // Keep the pager in sync with the focused pane.
                requestAnimationFrame(() => {
                  document
                    .querySelector(`.pane[data-pane="${p.id}"]`)
                    ?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
                });
              }}
            >
              {i() + 1} · {p.view()}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
