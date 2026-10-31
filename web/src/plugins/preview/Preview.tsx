import { Show, createEffect, createMemo, createSignal } from "solid-js";
import type { Entry, PaneApi, WorkspaceApi } from "../../core/types";
import { fetchPreview, fileUrl, type PreviewPayload } from "../../core/transport";
import { Icon, iconFor } from "../../icons";
import { fmtBytesExact, fmtDate, fmtRelative, fmtSize, isAudio, isMedia, isVideo } from "../../core/viewkit";
import { baseName } from "../../core/workspace";
import { useGrace } from "../../core/anim";
import { metrics } from "../../core/metrics";

/**
 * Preview / inspector — a plugin whose *content is a binding*.
 *
 * The pane is mounted with `source: "$p2"` (see the layout tree), and resolves
 * that binding to whatever the other pane has selected. Neither pane knows the
 * other exists.
 */
export default function Preview(props: { pane: PaneApi; workspace: WorkspaceApi }) {
  const [payload, setPayload] = createSignal<PreviewPayload | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const grace = useGrace(60);

  const sourceRef = () => props.pane.props()?.source ?? "$focused";

  /**
   * Where the content comes from:
   *   · bound pane  → resolve `$pane.field` (usually the other pane's selection)
   *   · standalone  → its own path
   */
  const target = createMemo<string | undefined>(() => {
    if (!props.pane.props()?.source && props.pane.path()) return props.pane.path();
    const resolved = props.workspace.resolve(sourceRef());
    if (typeof resolved === "string" && resolved) return resolved;
    if (Array.isArray(resolved) && resolved.length) return resolved[resolved.length - 1];
    return undefined;
  });

  const entry = createMemo<Entry | undefined>(() => {
    const ref = sourceRef();
    const m = /^\$([A-Za-z0-9_]+)/.exec(ref);
    if (!m) return undefined;
    const id = m[1] === "focused" ? props.workspace.focusedId() : m[1];
    const pane = id ? props.workspace.pane(id) : undefined;
    const path = target();
    if (!pane || !path) return undefined;
    return pane.entries().find((e) => path.endsWith(e.name));
  });

  let generation = 0;
  createEffect(() => {
    const path = target();
    if (!path) {
      setPayload(null);
      setError(null);
      return;
    }
    const gen = ++generation;
    const isDir = entry()?.kind === 1;
    if (isDir) {
      setPayload(null);
      setError(null);
      return;
    }
    setLoading(true);
    grace.reset();
    const t0 = performance.now();
    fetchPreview(path, 256 * 1024)
      .then((p) => {
        if (gen !== generation) return;
        metrics.push("preview.ms", performance.now() - t0);
        setPayload(p);
        setError(null);
      })
      .catch((e) => gen === generation && setError(String(e)))
      .finally(() => gen === generation && setLoading(false));
  });

  const dirCount = createMemo(() => {
    const m = /^\$([A-Za-z0-9_]+)/.exec(sourceRef());
    if (!m) return 0;
    const id = m[1] === "focused" ? props.workspace.focusedId() : m[1];
    const pane = id ? props.workspace.pane(id) : undefined;
    return pane ? pane.entries().length : 0;
  });

  const kind = () => {
    const e = entry();
    if (!e) return "none";
    if (e.kind === 1) return "dir";
    if (isMedia(e)) return "image";
    if (isAudio(e)) return "audio";
    if (isVideo(e)) return "video";
    if (e.kind === 3) return "archive";
    return "file";
  };

  return (
    <div class="preview">
      <div class="preview-head">
        <Icon name={entry() ? iconFor(entry()!) : "info"} size={15} />
        <span class="preview-title">{target() ? baseName(target()!) : "Nothing selected"}</span>
        <Show when={payload()}>
          <span class="preview-sub">
            {fmtSize(payload()!.size)} · {payload()!.mime}
          </span>
        </Show>
      </div>

      <div class="preview-body">
        <Show when={!target()}>
          <div class="empty">
            select a file
            <div style={{ "font-family": "var(--ui)", "font-size": "11.5px", "font-style": "normal", color: "var(--fg-faint)", "margin-top": "6px" }}>
              this pane follows {sourceRef()}
            </div>
          </div>
        </Show>

        <Show when={target() && entry()?.kind === 1}>
          <div class="empty">
            folder
            <div style={{ "font-family": "var(--mono)", "font-size": "11.5px", "font-style": "normal", color: "var(--fg-faint)", "margin-top": "6px" }}>
              {dirCount().toLocaleString()} items
            </div>
          </div>
        </Show>

        <Show when={target() && entry()?.kind !== 1 && loading() && !payload() && grace.elapsed()}>
          <div style={{ padding: "14px" }}>
            <div class="sk" style={{ height: "10px", width: "60%" }} />
            <div class="sk" style={{ height: "10px", width: "80%", "margin-top": "8px" }} />
            <div class="sk" style={{ height: "10px", width: "45%", "margin-top": "8px" }} />
          </div>
        </Show>

        <Show when={error()}>
          <div class="empty" style={{ color: "var(--danger)" }}>
            {error()}
          </div>
        </Show>

        <Show when={payload() && !error() ? payload() : undefined}>
          {(p) => (
            <>
              <Show when={kind() === "image"}>
                <div class="preview-media">
                  <img src={fileUrl(target()!)} alt="" class="thumb-fade" />
                </div>
              </Show>
              <Show when={kind() === "audio"}>
                <div class="preview-media">
                  <div style={{ width: "min(420px, 100%)" }}>
                    <div style={{ "font-family": "var(--display)", "font-size": "20px", "margin-bottom": "10px", "text-align": "center" }}>
                      {baseName(target()!)}
                    </div>
                    <audio controls src={fileUrl(target()!)} style={{ width: "100%" }} />
                  </div>
                </div>
              </Show>
              <Show when={kind() === "video"}>
                <div class="preview-media">
                  <video controls src={fileUrl(target()!)} style={{ "max-width": "100%", "max-height": "100%" }} />
                </div>
              </Show>
              <Show when={p().isText}>
                {/* highlight() escapes the source before adding its own spans,
                    so this is the one place innerHTML is safe and intended. */}
                <pre class="preview-code" innerHTML={highlight(p().head)} />
              </Show>
              <Show when={!p().isText && kind() === "file"}>
                <div class="preview-media dim" style={{ "font-family": "var(--mono)", "font-size": "12px" }}>
                  binary · {fmtBytesExact(p().size)}
                </div>
              </Show>
              <Show when={p().truncated}>
                <div class="dim" style={{ padding: "0 var(--pad-x) 8px", "font-size": "11px" }}>
                  showing the first {fmtSize(p().head.length)} of {fmtSize(p().size)}
                </div>
              </Show>
              <dl class="preview-meta">
                <dt>size</dt>
                <dd>{fmtBytesExact(p().size)}</dd>
                <dt>modified</dt>
                <dd>{entry() ? `${fmtDate(entry()!.mtime)} (${fmtRelative(entry()!.mtime)})` : "—"}</dd>
                <dt>type</dt>
                <dd>{p().mime}</dd>
                <dt>path</dt>
                <dd>{target()}</dd>
              </dl>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * Cheap, safe syntax tinting: escape *first*, then wrap tokens in spans.
 * The escaped text is the only input to the regexes below, so no markup from
 * the file can ever reach the DOM — the quotes in the patterns match literal
 * `"` characters, which by then are already inert.
 */
function highlight(text: string) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const lines = escaped.split("\n").slice(0, 400);
  return lines
    .map((line, i) => {
      const tinted = line
        .replace(/(&quot;|")[^"]*?(&quot;|")/g, (m) => `<i style="color:var(--good);font-style:normal">${m}</i>`)
        .replace(/\b(fn|let|const|struct|impl|pub|async|await|return|if|else|for|while|match|class|import|export|from|use|def)\b/g, (m) => `<i style="color:var(--accent);font-style:normal">${m}</i>`)
        .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => `<i style="color:var(--cool);font-style:normal">${m}</i>`)
        .replace(/(\/\/.*|#.*)$/g, (m) => `<i style="color:var(--fg-faint);font-style:normal">${m}</i>`);
      return `<span class="ln">${i + 1}</span>${tinted}`;
    })
    .join("\n");
}

/** Exported so the inspector plugin can reuse the line renderer. */
export { highlight };
