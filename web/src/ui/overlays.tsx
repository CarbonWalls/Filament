import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

/** Core UI primitives that plugins compose: context menu, prompt, toasts. */

export interface MenuItem {
  id: string;
  label?: string;
  key?: string;
  separator?: boolean;
  disabled?: boolean;
  danger?: boolean;
  header?: string;
  run?: () => void;
}

const [menu, setMenu] = createSignal<{ x: number; y: number; items: MenuItem[] } | null>(null);

export function openMenu(x: number, y: number, items: MenuItem[]) {
  setMenu({ x, y, items });
}
export function closeMenu() {
  setMenu(null);
}

/** Flip the menu so it always opens inside the viewport. */
function place(x: number, y: number, el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  el.style.left = `${Math.max(8, px)}px`;
  el.style.top = `${Math.max(8, py)}px`;
}

export function MenuHost() {
  let el: HTMLDivElement | undefined;
  const close = (e: Event) => {
    if (el && e.target instanceof Node && el.contains(e.target)) return;
    closeMenu();
  };
  onMount(() => {
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeMenu);
    onCleanup(() => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeMenu);
    });
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeMenu();
  };
  return (
    <Show when={menu()}>
      {(m) => (
        <Portal>
          <div
            class="menu"
            role="menu"
            ref={(node) => {
              el = node;
              requestAnimationFrame(() => place(m().x, m().y, node));
            }}
          >
            {m().items.map((item, i) =>
              item.separator ? (
                <div class="sep" />
              ) : item.header ? (
                <div class="menu-label">{item.header}</div>
              ) : (
                <button
                  type="button"
                  disabled={item.disabled}
                  style={item.danger ? { color: "var(--danger)" } : undefined}
                  onClick={() => {
                    closeMenu();
                    item.run?.();
                  }}
                  data-index={i}
                >
                  <span>{item.label}</span>
                  <Show when={item.key}>
                    <span class="k">{item.key}</span>
                  </Show>
                </button>
              )
            )}
          </div>
        </Portal>
      )}
    </Show>
  );
}

// ---------------------------------------------------------------- prompts --

export interface PromptSpec {
  title: string;
  detail?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  danger?: boolean;
  bare?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
}

const [prompt, setPrompt] = createSignal<PromptSpec | null>(null);

export function openPrompt(spec: PromptSpec) {
  setPrompt(spec);
}
export function closePrompt() {
  setPrompt(null);
}

export function PromptHost() {
  const [value, setValue] = createSignal("");
  let input: HTMLInputElement | undefined;
  return (
    <Show when={prompt()}>
      {(p) => {
        // Initialise once per prompt.
        queueMicrotask(() => {
          if (input && document.activeElement !== input) {
            setValue(p().value ?? "");
            input.focus();
            if (p().bare) input.select();
          }
        });
        return (
          <Portal>
            <div class="palette-scrim" onPointerDown={(e) => e.target === e.currentTarget && closePrompt()}>
              <form
                class="palette"
                style={{ "max-height": "min(60dvh, 320px)", padding: "0" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const v = value().trim();
                  if (!v) return;
                  closePrompt();
                  void p().onSubmit(v);
                }}
              >
                <div style={{ padding: "14px 16px 10px" }}>
                  <div style={{ "font-weight": 550, "font-size": "14px" }}>{p().title}</div>
                  <Show when={p().detail}>
                    <div class="dim" style={{ "margin-top": "2px", "font-size": "12px" }}>
                      {p().detail}
                    </div>
                  </Show>
                </div>
                <input
                  ref={input}
                  value={value()}
                  placeholder={p().placeholder}
                  spellcheck={false}
                  autocomplete="off"
                  onInput={(e) => setValue(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      closePrompt();
                    }
                  }}
                  style={{ "border-bottom": 0, "font-family": "var(--mono)" }}
                />
                <div style={{ display: "flex", gap: "8px", padding: "10px 16px 14px" }}>
                  <button
                    type="submit"
                    class="icon-btn"
                    style={{
                      width: "auto",
                      padding: "0 14px",
                      background: p().danger ? "var(--danger)" : "var(--accent)",
                      color: p().danger ? "#fff" : "var(--accent-ink)",
                      height: "32px",
                      "font-weight": 550,
                    }}
                  >
                    {p().confirmLabel ?? "OK"}
                  </button>
                  <button
                    type="button"
                    class="icon-btn"
                    style={{ width: "auto", padding: "0 12px", height: "32px" }}
                    onClick={closePrompt}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          </Portal>
        );
      }}
    </Show>
  );
}

// ------------------------------------------------------------------ toasts --

interface Toast {
  id: number;
  title: string;
  detail?: string;
  kind: "info" | "warn" | "error";
}

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastSeq = 0;

export function ToastHost() {
  const push = (t: Omit<Toast, "id">) => {
    const id = ++toastSeq;
    setToasts((list) => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.kind === "error" ? 6000 : 3200);
  };
  onMount(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent).detail as Partial<Omit<Toast, "id">>;
      push({ title: d.title ?? "Done", detail: d.detail, kind: d.kind ?? "info" });
    };
    window.addEventListener("filament:toast", handler);
    onCleanup(() => window.removeEventListener("filament:toast", handler));
  });
  return (
    <Portal>
      <div class="toast-layer">
        {toasts().map((t) => (
          <div class="toast" data-kind={t.kind}>
            <div class="toast-title">{t.title}</div>
            <Show when={t.detail}>
              <div class="toast-detail">{t.detail}</div>
            </Show>
          </div>
        ))}
      </div>
    </Portal>
  );
}

/** Imperative toast from anywhere (plugins, ops, transport errors). */
export function toast(t: { title: string; detail?: string; kind?: "info" | "warn" | "error" }) {
  const detail = { kind: "info" as const, ...t };
  window.dispatchEvent(new CustomEvent("filament:toast", { detail }));
}
