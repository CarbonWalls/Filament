import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { WorkspaceApi } from "../../core/types";
import { transport } from "../../core/transport";
import { listingsRev } from "../../core/listings";
import { registry } from "../../core/registry";
import { Icon } from "../../icons";
import { baseName } from "../../core/workspace";

/**
 * Sidebar / places — a plugin, mounted into the shell's `sidebar` chrome slot.
 * A place is just a path, so anything the daemon can list can be pinned here
 * (including a zip opened through the virtual-FS plugin).
 */
export default function Sidebar(props: { workspace: WorkspaceApi }) {
  const [home, setHome] = createSignal("");
  const [pins, setPins] = createSignal<string[]>(load());
  const [session, setSession] = createSignal<string[]>([]);

  onMount(() => {
    transport
      .request<{ home: string }>("hello")
      .then((r) => setHome(r.home))
      .catch(() => {});
    const unsub = registry.contextFor("sidebar-listener").on("navigate", (p: any) => {
      setSession((list) => [p.path, ...list.filter((x) => x !== p.path)].slice(0, 8));
    });
    const reload = () => setPins(load());
    window.addEventListener("filament:pins", reload);
    onCleanup(() => {
      unsub();
      window.removeEventListener("filament:pins", reload);
    });
  });

  const current = () => props.workspace.focused()?.path() ?? "";
  const active = (p: string) => current() === p || current().startsWith(p.replace(/\/$/, "") + "/");
  const goto = (p: string) => {
    const focused = props.workspace.focused();
    if (focused) props.workspace.pane(focused.id)?.navigate(p);
  };

  const togglePin = () => {
    const p = current();
    if (!p) return;
    const list = load();
    const next = list.includes(p) ? list.filter((x) => x !== p) : [...list, p];
    localStorage.setItem("filament.pins", JSON.stringify(next));
    window.dispatchEvent(new Event("filament:pins"));
  };

  const places = createMemo(() => {
    const out: { label: string; path: string; icon: string }[] = [];
    const h = home();
    if (h) out.push({ label: "Home", path: h, icon: "home" });
    if (h) out.push({ label: "Temporary", path: "/tmp", icon: "drive" });
    for (const p of pins()) out.push({ label: baseName(p) || p, path: p, icon: "pin" });
    return out;
  });

  return (
    <>
      <div class="sidebar-group">
        <div class="sidebar-title">
          <span>Places</span>
          <button class="icon-btn" style={{ width: "18px", height: "18px", "margin-left": "auto" }} title="Pin current folder" onClick={togglePin}>
            <Icon name="pin" size={12} />
          </button>
        </div>
        <For each={places()}>
          {(place) => (
            <button class="place" classList={{ active: active(place.path) }} onClick={() => goto(place.path)} title={place.path}>
              <Icon name={place.icon} size={14} />
              <span class="place-name">{place.label}</span>
              <Show when={active(place.path)}>
                <span class="place-dot" />
              </Show>
            </button>
          )}
        </For>
        <Show when={!home()}>
          <button class="place" disabled>
            <span class="place-name dim">connecting…</span>
          </button>
        </Show>
      </div>

      <RecentlyChanged workspace={props.workspace} />

      <Show when={session().length}>
        <div class="sidebar-group">
          <div class="sidebar-title">
            <span>This session</span>
          </div>
          <For each={session().slice(0, 6)}>
            {(p) => (
              <button class="place" onClick={() => goto(p)} title={p}>
                <Icon name="clock" size={14} />
                <span class="place-name">{baseName(p)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

/** Live "what changed in here" list, driven by the focused folder's listing. */
function RecentlyChanged(props: { workspace: WorkspaceApi }) {
  const top = createMemo(() => {
    listingsRev();
    const pane = props.workspace.focused();
    if (!pane) return [];
    return [...pane.entries()]
      .filter((e) => e.kind !== 1)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
  });
  return (
    <Show when={top().length}>
      <div class="sidebar-group">
        <div class="sidebar-title">
          <span>Recently changed</span>
        </div>
        <For each={top()}>
          {(e) => (
            <button
              class="place"
              onClick={() => {
                const pane = props.workspace.focused();
                if (!pane) return;
                const dir = pane.path();
                pane.setSelection([dir.endsWith("/") ? dir + e.name : `${dir}/${e.name}`]);
              }}
              title={e.name}
            >
              <Icon name="clock" size={14} />
              <span class="place-name">{e.name}</span>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

function load(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem("filament.pins") ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
