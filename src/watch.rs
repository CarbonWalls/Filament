use notify::{Event, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

/// Fans filesystem events out to WebSocket clients.
///
/// One OS watcher lives on a dedicated thread. Each WS connection opens a
/// *session* (an unbounded queue + the set of dirs it cares about); the
/// thread matches every notify event against all sessions. Sessions with a
/// dropped queue are pruned automatically.
pub struct WatchHub {
    req_tx: mpsc::Sender<PathBuf>,
    sessions: Arc<Mutex<Vec<Session>>>,
}

struct Session {
    tx: UnboundedSender<String>,
    dirs: Arc<Mutex<HashSet<PathBuf>>>,
}

pub type SessionDirs = Arc<Mutex<HashSet<PathBuf>>>;

impl WatchHub {
    pub fn new() -> Self {
        let (req_tx, req_rx) = mpsc::channel::<PathBuf>();
        let sessions: Arc<Mutex<Vec<Session>>> = Arc::new(Mutex::new(Vec::new()));
        let (ev_tx, ev_rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher = notify::recommended_watcher(move |res| {
            let _ = ev_tx.send(res);
        })
        .expect("create filesystem watcher");

        let watched: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
        let sessions_for_watch = sessions.clone();
        let sessions_for_events = sessions.clone();
        let watched_for_watch = watched.clone();

        // Dispatcher thread: fold watch requests, prune dead sessions,
        // and route events to interested sessions. 100ms tick.
        std::thread::spawn(move || {
            loop {
                loop {
                    match req_rx.recv_timeout(Duration::from_millis(100)) {
                        Ok(dir) => {
                            if watched_for_watch.lock().unwrap().contains(&dir) {
                                continue;
                            }
                            if watcher.watch(&dir, RecursiveMode::NonRecursive).is_ok() {
                                watched_for_watch.lock().unwrap().insert(dir);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => break,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                }

                // Prune sessions whose receiver is gone (liveness probe is
                // is_closed(), never a dummy message — clients must never see
                // a frame that isn't part of the protocol).
                sessions_for_watch.lock().unwrap().retain(|s| !s.tx.is_closed());

                // Dispatch events.
                while let Ok(res) = ev_rx.try_recv() {
                    let Ok(event) = res else { continue };
                    let parents: Vec<PathBuf> = event
                        .paths
                        .iter()
                        .filter_map(|p| p.parent().map(|d| d.to_path_buf()))
                        .collect();
                    let payload = serde_json::to_string(&serde_json::json!({
                        "ev": "fsevent",
                        "kind": format!("{:?}", event.kind),
                        "paths": event
                            .paths
                            .iter()
                            .map(|p| p.to_string_lossy().to_string())
                            .collect::<Vec<_>>(),
                    }))
                    .unwrap_or_default();
                    let mut dead = Vec::new();
                    let mut map = sessions_for_events.lock().unwrap();
                    for (i, s) in map.iter().enumerate() {
                        let dirs = s.dirs.lock().unwrap();
                        let relevant = parents.iter().any(|p| dirs.contains(p));
                        drop(dirs);
                        if !relevant {
                            continue;
                        }
                        if s.tx.send(payload.clone()).is_err() {
                            dead.push(i);
                        }
                    }
                    for i in dead.into_iter().rev() {
                        map.remove(i);
                    }
                }
            }
        });

        WatchHub {
            req_tx,
            sessions,
        }
    }

    /// Opens a session: returns the dir set (mutate to subscribe/unsubscribe)
    /// and the queue to drain in the connection loop.
    pub fn session(&self) -> (SessionDirs, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let dirs: SessionDirs = Arc::new(Mutex::new(HashSet::new()));
        self.sessions.lock().unwrap().push(Session {
            tx,
            dirs: dirs.clone(),
        });
        (dirs, rx)
    }

    pub fn watch_dir(&self, dir: PathBuf) {
        let _ = self.req_tx.send(dir);
    }

}


/// Convenience: is `path` directly inside one of the watched dirs?
pub fn is_direct_child(watched: &HashSet<PathBuf>, p: &Path) -> bool {
    p.parent().map(|d| watched.contains(d)).unwrap_or(false)
}
