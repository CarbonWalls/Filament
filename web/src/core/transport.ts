
/**
 * Daemon transport.
 *
 * One WebSocket carries every listing, search and mutation. Requests are
 * JSON-RPC-ish: {id, method, params}; responses are {id, ok, result} for the
 * final value and {id, ev, …} for streamed frames. Broadcast frames (watch
 * events) have no id. A tiny HTTP surface (/api/thumb, /api/preview,
 * /api/file) exists only for things the browser should fetch as bytes.
 */

type Frame = Record<string, any>;
type Handler = (frame: Frame) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onFrame?: Handler;
}

class Transport {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private listeners = new Set<Handler>();
  private seq = 0;
  private queue: string[] = [];
  private ready = false;
  private reconnectAttempts = 0;

  async connect(): Promise<void> {
    if (this.ws && this.ready) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 8000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.ready = true;
        this.reconnectAttempts = 0;
        for (const q of this.queue.splice(0)) ws.send(q);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("ws error"));
      };
    });
    ws.onmessage = (e) => {
      let frame: Frame;
      try {
        frame = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (frame.id && this.pending.has(frame.id)) {
        const p = this.pending.get(frame.id)!;
        if (frame.ev) {
          p.onFrame?.(frame);
          return;
        }
        this.pending.delete(frame.id);
        if (frame.err) p.reject(new Error(String(frame.err)));
        else p.resolve(frame.result);
        return;
      }
      for (const l of this.listeners) l(frame);
    };
    ws.onclose = () => {
      this.ready = false;
      for (const [, p] of this.pending) p.reject(new Error("connection lost"));
      this.pending.clear();
      // Reconnect with backoff; the UI keeps working against cached data.
      if (this.reconnectAttempts++ < 12) {
        setTimeout(() => {
          this.connect().catch(() => {});
        }, Math.min(4000, 150 * 2 ** this.reconnectAttempts));
      }
    };
  }

  private send(raw: string) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(raw);
    else this.queue.push(raw);
  }

  /** Request/response. */
  request<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Streaming request: onFrame gets every intermediate frame. */
  stream<T = any>(
    method: string,
    params: Record<string, any>,
    onFrame: Handler
  ): { id: string; done: Promise<T> } {
    const id = params.id ?? `s${++this.seq}`;
    const done = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onFrame });
      this.send(JSON.stringify({ id, method, params }));
    });
    return { id, done };
  }

  cancel(id: string) {
    this.send(JSON.stringify({ id, method: "cancel", params: {} }));
  }

  /** Broadcast frames (fs events, etc). */
  subscribe(h: Handler): () => void {
    this.listeners.add(h);
    return () => this.listeners.delete(h);
  }

  /** Low-level: send an arbitrary frame (used for `watch`). */
  sendFrame(frame: Frame) {
    this.send(JSON.stringify(frame));
  }
}

export const transport = new Transport();

// ---- byte endpoints -------------------------------------------------------

export const thumbUrl = (path: string, size = 256) =>
  `/api/thumb?size=${size}&path=${encodeURIComponent(path)}`;

export const fileUrl = (path: string) => `/api/file?path=${encodeURIComponent(path)}`;

export const previewUrl = (path: string, max = 262144) =>
  `/api/preview?max=${max}&path=${encodeURIComponent(path)}`;

export interface PreviewPayload {
  mime: string;
  isText: boolean;
  size: number;
  truncated: boolean;
  head: string;
}

export async function fetchPreview(path: string, max = 262144): Promise<PreviewPayload> {
  const res = await fetch(previewUrl(path, max));
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as PreviewPayload;
}
