import { For, Show, createMemo, createSignal } from "solid-js";
import type { WorkspaceApi } from "../../core/types";
import { transport } from "../../core/transport";
import { Icon } from "../../icons";

/**
 * Global search — a plugin view (mountable in any pane) plus a command.
 * Results stream in batches from the daemon's walker, so a huge tree shows its
 * first hits almost immediately instead of blocking on the whole scan.
 */
export default function SearchView(props: { pane: any; workspace: WorkspaceApi }) {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<{ path: string; name: string; kind: number; size: number }[]>([]);
  const [running, setRunning] = createSignal(false);
  const [elapsed, setElapsed] = createSignal<number | null>(null);
  let currentId: string | undefined;
  let timer: number | undefined;

  const root = () => props.pane.path() || props.workspace.focused()?.path() || "/";

  const search = (q: string) => {
    clearTimeout(timer);
    if (currentId) transport.cancel(currentId);
    if (q.trim().length < 2) {
      setHits([]);
      setRunning(false);
      return;
    }
    timer = setTimeout(() => {
      setHits([]);
      setRunning(true);
      setElapsed(null);
      const s = transport.stream("search", { root: root(), query: q.trim(), limit: 400 }, (frame) => {
        if (frame.ev === "hits") setHits((h) => [...h, ...frame.hits]);
        if (frame.ev === "done") {
          setRunning(false);
          setElapsed(frame.ms);
        }
      });
      currentId = s.id;
      s.done.catch(() => setRunning(false));
    }, 110) as unknown as number;
  };

  const grouped = createMemo(() => hits());

  return (
    <div style={{ display: "flex", "flex-direction": "column", "min-height": 0, flex: 1 }}>
      <div class="cols-head" style={{ display: "flex", gap: "8px" }}>
        <Icon name="search" size={13} />
        <span class="dim" style={{ "text-transform": "none", "letter-spacing": 0 }}>in {root()}</span>
        <span style={{ flex: 1 }} />
        <Show when={running()}>
          <span class="dim">searching…</span>
        </Show>
        <Show when={elapsed() !== null && !running()}>
          <span class="dim">{hits().length} hits in {Math.round(elapsed()!)}ms</span>
        </Show>
      </div>
      <div style={{ padding: "8px var(--pad-x)" }}>
        <div class="search-field" style={{ width: "100%" }}>
          <Icon name="search" size={13} />
          <input
            value={query()}
            placeholder="Find files by name…"
            spellcheck={false}
            autofocus
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              search(e.currentTarget.value);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter" && hits()[0]) {
                const dir = hits()[0].path.replace(/\/[^/]+$/, "");
                props.workspace.navigate(props.pane.id, dir);
                setTimeout(() => props.pane.setSelection([hits()[0].path]), 160);
              }
            }}
          />
        </div>
      </div>
      <div style={{ overflow: "auto", flex: 1, "min-height": 0 }}>
        <For each={grouped()}>
          {(hit) => (
            <div
              class="row"
              style={{ position: "relative", height: "30px" }}
              onClick={() => {
                const dir = hit.path.replace(/\/[^/]+$/, "");
                props.workspace.navigate(props.pane.id, dir);
                setTimeout(() => props.pane.setSelection([hit.path]), 160);
              }}
            >
              <span class="row-icon">
                <Icon name={hit.kind === 1 ? "folder" : "file"} size={15} />
              </span>
              <span class="row-name">
                <span class="base">{hit.name}</span>
              </span>
              <span class="row-meta" style={{ "grid-column": "3 / span 2", "max-width": "40ch", overflow: "hidden", "text-overflow": "ellipsis" }}>
                {hit.path}
              </span>
            </div>
          )}
        </For>
        <Show when={!hits().length && query().length >= 2 && !running()}>
          <div class="empty">no matches</div>
        </Show>
        <Show when={query().length < 2}>
          <div class="empty">
            type at least two characters
            <div class="dim" style={{ "font-family": "var(--ui)", "font-size": "11.5px", "font-style": "normal", "margin-top": "6px" }}>
              searching under {root()}
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
