import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { registry, commandBus } from "../../core/registry";
import { Icon } from "../../icons";

/**
 * Keyboard help + the shortcut sheet. Reads the registry, so it can never go
 * stale as plugins come and go. (`?` opens it.)
 */
export default function KeysHelp() {
  const [open, setOpen] = createSignal(false);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape" && open()) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const groups = createMemo(() => {
    const out = new Map<string, { title: string; key?: string }[]>();
    for (const cmd of registry.commands.values()) {
      if (!cmd.key) continue;
      const g = cmd.group ?? "Other";
      const list = out.get(g) ?? [];
      list.push({ title: cmd.title, key: prettyKey(cmd.key) });
      out.set(g, list);
    }
    return [...out.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const run = (id: string) => {
    setOpen(false);
    commandBus.run(id);
  };

  return (
    <>
      <Show when={open()}>
        <Portal>
          <div class="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div class="palette" style={{ width: "min(720px, 94cqi)", "max-height": "min(72dvh, 640px)" }}>
              <div style={{ padding: "12px 16px", "border-bottom": "1px solid var(--line)", display: "flex", "align-items": "center", gap: "8px" }}>
                <Icon name="keyboard" size={15} />
                <b>Keyboard</b>
                <span class="dim" style={{ "font-size": "12px" }}>every shortcut is registered by a plugin</span>
              </div>
              <div class="palette-list" style={{ display: "grid", "grid-template-columns": "repeat(auto-fit, minmax(240px, 1fr))", gap: "10px" }}>
                <For each={groups()}>
                  {([group, items]) => (
                    <div>
                      <div class="menu-label">{group}</div>
                      <For each={items}>
                        {(item) => (
                          <div style={{ display: "flex", gap: "10px", padding: "3px 9px", "align-items": "center" }}>
                            <span class="dim" style={{ flex: 1 }}>{item.title}</span>
                            <span class="k" style={{ "font-family": "var(--mono)", "font-size": "10.5px", border: "1px solid var(--line)", "border-radius": "3px", padding: "1px 5px" }}>
                              {item.key}
                            </span>
                          </div>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
              <div style={{ padding: "8px 16px", "border-top": "1px solid var(--line)", display: "flex", gap: "6px" }}>
                <button class="palette-item" style={{ width: "auto" }} onClick={() => run("palette.open")}>
                  <Icon name="zap" size={13} /> Open command palette
                </button>
                <button class="palette-item" style={{ width: "auto" }} onClick={() => run("settings.open")}>
                  <Icon name="settings" size={13} /> Settings
                </button>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}

function prettyKey(key: string): string {
  const mac = navigator.platform.toLowerCase().includes("mac");
  return key
    .split("+")
    .map((p) => {
      if (p === "mod") return mac ? "⌘" : "Ctrl";
      if (p === "alt") return mac ? "⌥" : "Alt";
      if (p === "shift") return mac ? "⇧" : "Shift";
      if (p === "arrowleft") return "←";
      if (p === "arrowright") return "→";
      if (p === "arrowup") return "↑";
      if (p === "arrowdown") return "↓";
      if (p === "delete") return "Del";
      if (p === "backspace") return "⌫";
      if (p === "escape") return "Esc";
      if (p === "space") return "Space";
      if (p === "tab") return "Tab";
      return p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    })
    .join(mac ? "" : "+");
}
