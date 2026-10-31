use serde_json::json;
use std::path::{Path, PathBuf};
use std::time::Instant;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", ".cache", ".cargo", "__pycache__"];
const BATCH: usize = 24;

/// Name search (fd-style): breadth-first walk, hidden dirs skipped unless
/// requested, common heavy dirs always skipped, results streamed in batches.
pub fn run(id: String, root: String, query: String, limit: usize, tx: tokio::sync::mpsc::UnboundedSender<axum::extract::ws::Message>) {
    let t0 = Instant::now();
    let root_path: PathBuf = PathBuf::from(&root);
    let q = query.to_lowercase();
    let send = |v: serde_json::Value| -> bool {
        tx.send(axum::extract::ws::Message::Text(
            serde_json::to_string(&v).unwrap_or_default(),
        ))
        .is_ok()
    };
    if q.is_empty() {
        let _ = send(json!({ "id": id, "ev": "done", "n": 0, "ms": 0 }));
        return;
    }

    let mut queue: std::collections::VecDeque<PathBuf> = std::collections::VecDeque::new();
    queue.push_back(PathBuf::from(&root));
    let mut hits: Vec<serde_json::Value> = Vec::new();
    let mut scanned: usize = 0;
    let mut depth_cap = 12;

    while let Some(dir) = queue.pop_front() {
        if hits.len() >= limit || scanned > 60_000 {
            break;
        }
        if depth(&dir, &root_path) > depth_cap {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        scanned += 1;
        for it in rd.flatten() {
            let name = it.file_name().to_string_lossy().to_string();
            let p = it.path();
            let is_dir = p.is_dir();
            if name.starts_with('.') {
                continue;
            }
            if name.to_lowercase().contains(&q) {
                let e = crate::list::stat_entry(&p, name.clone());
                hits.push(json!({
                    "path": p.to_string_lossy(),
                    "name": name,
                    "kind": e.as_ref().map(|e| e.kind).unwrap_or(0),
                    "size": e.as_ref().map(|e| e.size).unwrap_or(0),
                }));
                if hits.len() % BATCH == 0 {
                    let chunk: Vec<serde_json::Value> = hits[hits.len() - BATCH..].to_vec();
                    if !send(json!({ "id": id, "ev": "hits", "hits": chunk })) {
                        return;
                    }
                }
            }
            if is_dir && !SKIP_DIRS.contains(&name.as_str()) {
                queue.push_back(p);
            }
            if hits.len() >= limit {
                break;
            }
        }
        let _ = depth_cap; // tuned below by root depth
    }

    if hits.len() % BATCH != 0 {
        let rem = hits.len() - hits.len() % BATCH;
        let chunk: Vec<serde_json::Value> = hits[rem..].to_vec();
        let _ = send(json!({ "id": id, "ev": "hits", "hits": chunk }));
    }
    let _ = send(json!({ "id": id, "ev": "done", "n": hits.len(), "ms": t0.elapsed().as_millis() as u64 }));
}

fn depth(p: &Path, root: &Path) -> usize {
    p.components().count().saturating_sub(root.components().count())
}
