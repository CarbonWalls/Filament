import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { settings, setMany, update, type Settings } from "../../core/settings";
import { registry } from "../../core/registry";
import { Icon } from "../../icons";

/** Settings — a plugin, which is why the shell has no options screen either. */
export default function SettingsPanel() {
  const [open, setOpen] = createSignal(false);

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const themes = createMemo(() => {
    registry.revision();
    return [...registry.themes.values()];
  });

  const applyTheme = async (id: string) => {
    update("theme", id);
    document.documentElement.dataset.theme = id;
    await registry.themes.get(id)?.load();
  };

  const toggle = (key: keyof Settings) => {
    setMany({ [key]: !settings[key] } as Partial<Settings>);
  };

  const rows: { key: keyof Settings; title: string; detail: string }[] = [
    { key: "hoverPrefetch", title: "Hover prefetch", detail: "Warm a folder after 120 ms of dwell" },
    { key: "viewportPrefetch", title: "Viewport prefetch", detail: "Warm folders as they scroll into view" },
    { key: "idlePrefetch", title: "Idle prefetch", detail: "Warm siblings and history when nothing is happening" },
    { key: "viewTransitions", title: "View Transitions API", detail: "Use the browser's snapshot transition when available" },
    { key: "confirmDelete", title: "Confirm destructive actions", detail: "Ask before moving things to the trash" },
    { key: "showHidden", title: "Show hidden files by default", detail: "New panes start with dotfiles visible" },
  ];

  return (
    <>
      <button class="icon-btn" title="Settings (Ctrl/Cmd+,)" aria-label="Settings" onClick={() => setOpen(true)}>
        <Icon name="settings" />
      </button>
      <Show when={open()}>
        <Portal>
          <div class="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
            <div class="palette" style={{ width: "min(560px, 92cqi)" }}>
              <div style={{ padding: "14px 16px", "border-bottom": "1px solid var(--line)", display: "flex", gap: "8px", "align-items": "center" }}>
                <Icon name="settings" size={15} />
                <b>Settings</b>
                <span class="grow" style={{ flex: 1 }} />
                <button class="icon-btn" onClick={() => setOpen(false)}>
                  <Icon name="close" />
                </button>
              </div>
              <div class="palette-list" style={{ padding: "12px 16px", display: "grid", gap: "12px" }}>
                <div>
                  <div class="menu-label" style={{ padding: "0 0 6px" }}>Theme</div>
                  <div style={{ display: "flex", gap: "6px", "flex-wrap": "wrap" }}>
                    <For each={themes()}>
                      {(t) => (
                        <button
                          class="palette-item"
                          style={{ width: "auto" }}
                          data-active={settings.theme === t.id}
                          onClick={() => void applyTheme(t.id)}
                        >
                          <Icon name="palette" size={13} />
                          {t.title}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <div>
                  <div class="menu-label" style={{ padding: "0 0 6px" }}>Motion</div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <For each={["auto", "full", "reduced"] as const}>
                      {(m) => (
                        <button
                          class="palette-item"
                          style={{ width: "auto" }}
                          data-active={settings.motion === m}
                          onClick={() => {
                            update("motion", m);
                            document.documentElement.dataset.motion = m === "reduced" ? "reduced" : "full";
                          }}
                        >
                          {m}
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="dim" style={{ "font-size": "11px", "margin-top": "4px" }}>
                    auto follows <span class="mono">prefers-reduced-motion</span>
                  </div>
                </div>

                <div>
                  <div class="menu-label" style={{ padding: "0 0 6px" }}>Density</div>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <For each={["comfortable", "compact"] as const}>
                      {(d) => (
                        <button
                          class="palette-item"
                          style={{ width: "auto" }}
                          data-active={settings.density === d}
                          onClick={() => {
                            update("density", d);
                            document.documentElement.dataset.density = d;
                          }}
                        >
                          {d}
                        </button>
                      )}
                    </For>
                  </div>
                </div>

                <div>
                  <div class="menu-label" style={{ padding: "0 0 6px" }}>Latency hiding</div>
                  <For each={rows}>
                    {(row) => (
                      <label style={{ display: "flex", gap: "10px", padding: "4px 0", "align-items": "flex-start", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={settings[row.key] as boolean}
                          onChange={() => toggle(row.key)}
                          style={{ "margin-top": "3px", "accent-color": "var(--accent)" }}
                        />
                        <span>
                          <span>{row.title}</span>
                          <span class="dim" style={{ display: "block", "font-size": "11px" }}>{row.detail}</span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  );
}
