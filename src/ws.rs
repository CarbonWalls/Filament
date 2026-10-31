use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// One WS connection: JSON-RPC-ish request/response with streamed event
/// frames. Frames:
///   client → {id, method, params}            ("cancel" aborts a stream)
///   server → {id, ok, result} | {id, err}    final
///   server → {id, ev, …}                     streamed frames for that id
///   server → {ev, …}                         broadcast (fsevent)
pub async fn ws_route(ws: WebSocketUpgrade, State(app): State<AppState>) -> axum::response::Response {
    ws.on_upgrade(move |socket| connection(socket, app))
}

async fn connection(mut socket: WebSocket, app: AppState) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let (dirs, mut fsev_rx) = app.0.watch.session();

    loop {
        tokio::select! {
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&text) {
                            dispatch(&app, v, tx.clone(), cancels.clone(), &dirs).await;
                        }
                    }
                    Some(Ok(Message::Ping(d))) => { let _ = socket.send(Message::Pong(d)).await; }
                    Some(Ok(Message::Close(_))) | None => break,
                    _ => {}
                }
            }
            Some(frame) = rx.recv() => {
                if socket.send(frame).await.is_err() { break; }
            }
            Some(payload) = fsev_rx.recv() => {
                if socket.send(Message::Text(payload)).await.is_err() { break; }
            }
            else => break,
        }
    }
}

async fn dispatch(
    app: &AppState,
    v: Value,
    tx: mpsc::UnboundedSender<Message>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    dirs: &crate::watch::SessionDirs,
) {
    let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
    let method = v.get("method").and_then(|m| m.as_str()).unwrap_or("").to_string();
    let params = v.get("params").cloned().unwrap_or(json!({}));

    let (tx_ok, id_ok) = (tx.clone(), id.clone());
    let ok = move |result: Value| {
        let _ = tx_ok.send(Message::Text(
            serde_json::to_string(&json!({ "id": id_ok, "ok": true, "result": result })).unwrap(),
        ));
    };
    let (tx_err, id_err) = (tx.clone(), id.clone());
    let err = move |e: &str| {
        let _ = tx_err.send(Message::Text(
            serde_json::to_string(&json!({ "id": id_err, "err": e })).unwrap(),
        ));
    };
    let tx_s = tx.clone();
    let stream = move |frame: Value| {
        let _ = tx_s.send(Message::Text(
            serde_json::to_string(&frame).unwrap_or_default(),
        ));
    };

    match method.as_str() {
        "hello" => ok(json!({
            "home": dirs::home_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "/".into()),
            "platform": std::env::consts::OS,
            "version": env!("CARGO_PKG_VERSION"),
            "plugins": app.0.plugins.manifest_summaries(),
            "slowMs": app.0.slow_ms.load(Ordering::Relaxed),
            "uptimeMs": app.0.started.elapsed().as_millis() as u64,
        })),
        "cancel" => {
            if let Some(flag) = cancels.lock().unwrap().get(id.as_str()) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        "list" => {
            let Some(path) = params.get("path").and_then(|p| p.as_str()).map(String::from) else {
                return err("missing path");
            };
            let show_hidden = params.get("showHidden").and_then(|h| h.as_bool()).unwrap_or(false);
            let flag = Arc::new(AtomicBool::new(false));
            cancels.lock().unwrap().insert(id.clone(), flag.clone());
            let db = app.0.db.clone();
            let tx2 = tx.clone();
            let id2 = id.clone();
            let stream_c = stream.clone();

            // Phase 1: cached listing straight out of SQLite.
            let cached = db.cached(&path);
            let now_mtime = crate::list::dir_mtime(std::path::Path::new(&path));
            if let Some((dmt, entries)) = &cached {
                let valid = now_mtime.map(|m| m == *dmt).unwrap_or(false);
                stream_c(json!({
                    "id": id, "ev": "cached", "entries": entries,
                    "dir_mtime": dmt, "valid": valid,
                }));
            }

            // Virtual FS route (archive paths).
            if let Some((archive, inner)) = crate::list::split_archive(&path) {
                let app2 = app.clone();
                let stream_c2 = stream.clone();
                tokio::task::spawn_blocking(move || {
                    let t0 = std::time::Instant::now();
                    match app2.0.plugins.plugin_list(&archive, &inner) {
                        Ok(entries) => {
                            stream_c2(json!({ "id": id2, "ev": "entries", "entries": entries, "n": entries.len() }));
                            stream_c2(json!({ "id": id2, "ev": "done", "n": entries.len(), "ms": t0.elapsed().as_millis() as u64, "virtual": true }));
                        }
                        Err(e) => err(&e),
                    }
                });
                return;
            }

            // Debug-only artificial delay (never set in normal operation).
            let delay = app.0.slow_ms.load(Ordering::Relaxed);
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }

            // Phase 2: fresh streamed scan.
            let p = std::path::PathBuf::from(&path);
            if !p.is_dir() {
                return err("not a directory");
            }
            let _ = app.0.watch.watch_dir(p.clone());
            let (ftx, frx) = std::sync::mpsc::channel::<String>();
            let db2 = db.clone();
            let id3 = id.clone();
            let _ = tokio::task::spawn_blocking(move || {
                crate::list::scan_dir(id3, p, show_hidden, flag, ftx, db2);
            });
            tokio::spawn(async move {
                for line in frx {
                    if tx2.send(Message::Text(line)).is_err() {
                        break;
                    }
                }
                cancels.lock().unwrap().remove(&id2);
            });
        }
        "search" => {
            let Some(root) = params.get("root").and_then(|p| p.as_str()).map(String::from) else {
                return err("missing root");
            };
            let query = params.get("query").and_then(|q| q.as_str()).unwrap_or("").to_string();
            let limit = params.get("limit").and_then(|l| l.as_u64()).unwrap_or(200) as usize;
            let tx2 = tx.clone();
            let id2 = id.clone();
            tokio::task::spawn_blocking(move || {
                crate::search::run(id2, root, query, limit, tx2);
            });
        }
        "debug.delay" => {
            if !app.0.allow_debug {
                return err("debug methods require --allow-debug");
            }
            let ms = params.get("ms").and_then(|m| m.as_u64()).unwrap_or(0);
            app.0.slow_ms.store(ms, Ordering::Relaxed);
            ok(json!({ "slowMs": ms }))
        }
        "op" => {
            let res = crate::ops::run(&params).await;
            match res {
                Ok(msg) => ok(json!({ "msg": msg })),
                Err(e) => err(&e),
            }
        }
        "watch" => {
            let Some(path) = params.get("path").and_then(|p| p.as_str()).map(String::from) else {
                return err("missing path");
            };
            app.0.watch.watch_dir(std::path::PathBuf::from(&path));
            dirs.lock().unwrap().insert(std::path::PathBuf::from(path));
            ok(json!({ "watching": true }));
        }
        "unwatch" => {
            if let Some(path) = params.get("path").and_then(|p| p.as_str()) {
                dirs.lock().unwrap().remove(std::path::Path::new(path));
            }
            ok(json!({ "watching": false }));
        }
        other => err(&format!("unknown method '{other}'")),
    }
}
