use crate::db::Entry;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

pub const FIRST_PAGE: usize = 96;
pub const CHUNK: usize = 256;
/// Cap on rows persisted per directory (protects the DB from /proc-style dirs).
const DB_CAP: usize = 20_000;

pub const ARCHIVE_SEP: &str = "!/";

/// `a.zip!/inner/dir` → Some(("a.zip", "inner/dir"))
pub fn split_archive(path: &str) -> Option<(String, String)> {
    let i = path.find(ARCHIVE_SEP)?;
    let archive = path[..i].trim_end().to_string();
    let inner = path[i + ARCHIVE_SEP.len()..].trim_matches('/').to_string();
    if archive.is_empty() {
        None
    } else {
        Some((archive, inner))
    }
}

pub fn is_archive(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".zip")
}

pub fn ext_of(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn classify(meta: &fs::Metadata, name: &str) -> u8 {
    let ft = meta.file_type();
    if ft.is_dir() {
        1
    } else if ft.is_symlink() {
        2
    } else if is_archive(name) {
        3
    } else {
        0
    }
}

pub fn stat_entry(path: &Path, name: String) -> Option<Entry> {
    let meta = fs::metadata(path).ok().or_else(|| fs::symlink_metadata(path).ok())?;
    let kind = classify(&meta, &name);
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = if kind == 1 { 0 } else { meta.len() };
    let ext = ext_of(&name);
    Some(Entry {
        name,
        kind,
        size,
        mtime,
        ext,
    })
}

pub fn dir_mtime(path: &Path) -> Option<i64> {
    let meta = fs::metadata(path).ok()?;
    let t = meta.modified().ok()?;
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
}

/// Frame sender shared with the streaming scan task.
pub type FrameTx = std::sync::mpsc::Sender<String>;

pub fn frame(v: serde_json::Value) -> String {
    serde_json::to_string(&v).unwrap_or_default()
}

/// Blocking scanner: readdir + stat in batches. Sends the first page before
/// the scan completes so the client can paint immediately.
pub fn scan_dir(
    id: String,
    path: PathBuf,
    show_hidden: bool,
    cancel: Arc<AtomicBool>,
    tx: FrameTx,
    db: crate::db::Db,
) {
    let t0 = Instant::now();
    let send = |s: String| -> bool { tx.send(s).is_ok() };

    let dmt = dir_mtime(&path).unwrap_or(0);

    let mut count: usize = 0usize;
    let mut buf: Vec<Entry> = Vec::with_capacity(CHUNK);
    let mut all: Vec<Entry> = Vec::new();

    match fs::read_dir(&path) {
        Ok(rd) => {
            for it in rd {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(it) = it else { continue };
                let name = it.file_name().to_string_lossy().to_string();
                if show_hidden || !name.starts_with('.') {
                    if let Some(e) = stat_entry(&it.path(), name) {
                        count += 1;
                        buf.push(e.clone());
                        all.push(e);
                        if buf.len() >= CHUNK {
                            if !send(frame(json!({
                                "id": id,
                                "ev": "entries",
                                "entries": buf,
                                "n": count,
                            }))) {
                                return;
                            }
                            buf = Vec::with_capacity(CHUNK);
                        }
                    }
                }
            }
        }
        Err(e) => {
            send(frame(json!({ "id": id, "err": e.to_string() })));
            return;
        }
    }

    if !buf.is_empty() {
        let b = std::mem::take(&mut buf);
        if !send(frame(json!({ "id": id, "ev": "entries", "entries": b, "n": count }))) {
            return;
        }
    }

    // Persist for the next cold start (skip giant dirs).
    if all.len() <= DB_CAP && !cancel.load(Ordering::Relaxed) {
        db.put(&path.to_string_lossy(), dmt, &all);
    }

    send(frame(json!({
        "id": id,
        "ev": "done",
        "n": count,
        "dir_mtime": dmt,
        "ms": t0.elapsed().as_millis() as u64,
    })));
}
