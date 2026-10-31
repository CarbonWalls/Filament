use serde_json::Value;
use std::path::{Path, PathBuf};

fn resolve(base: &str, name: &str) -> PathBuf {
    // Prevent escaping via ".." or absolute components in `name`.
    let safe: PathBuf = Path::new(name)
        .components()
        .filter(|c| matches!(c, std::path::Component::Normal(_)))
        .collect();
    Path::new(base).join(safe)
}

/// File operations. Mutations go through the WS `op` method.
pub async fn run(params: &Value) -> Result<String, String> {
    let op = params.get("op").and_then(|o| o.as_str()).unwrap_or("");
    let srcs: Vec<String> = params
        .get("src")
        .and_then(|s| s.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let dest = params.get("dest").and_then(|d| d.as_str()).map(String::from);
    let name = params.get("name").and_then(|n| n.as_str()).map(String::from);

    match op {
        "mkdir" => {
            let dest = dest.ok_or("missing dest")?;
            let target = match name {
                Some(n) => resolve(&dest, &n),
                None => PathBuf::from(&dest),
            };
            let mut final_target = target.clone();
            let mut i = 2;
            while final_target.exists() {
                let stem = target
                    .file_name()
                    .map(|f| f.to_string_lossy().to_string())
                    .unwrap_or_else(|| "folder".into());
                final_target = target.with_file_name(format!("{stem} ({i})"));
                i += 1;
            }
            std::fs::create_dir(&final_target).map_err(|e| e.to_string())?;
            Ok(final_target.to_string_lossy().to_string())
        }
        "newfile" => {
            let dest = dest.ok_or("missing dest")?;
            let target = match name {
                Some(n) => resolve(&dest, &n),
                None => return Err("missing name".into()),
            };
            if target.exists() {
                return Err("already exists".into());
            }
            std::fs::write(&target, b"").map_err(|e| e.to_string())?;
            Ok(target.to_string_lossy().to_string())
        }
        "rename" => {
            let src = srcs.first().ok_or("missing src")?;
            let name = name.ok_or("missing name")?;
            let from = PathBuf::from(src);
            let parent = from.parent().ok_or("no parent")?;
            let to = resolve(&parent.to_string_lossy(), &name);
            if to.exists() {
                return Err("target exists".into());
            }
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
            Ok(to.to_string_lossy().to_string())
        }
        "copy" => {
            let dest = dest.ok_or("missing dest")?;
            let dest_dir = PathBuf::from(&dest);
            if !dest_dir.is_dir() {
                return Err("dest is not a directory".into());
            }
            for src in &srcs {
                let from = PathBuf::from(src);
                if from.is_dir() && dest_dir.starts_with(&from) {
                    return Err("cannot copy into itself".into());
                }
                let fname = from
                    .file_name()
                    .ok_or("bad src")?
                    .to_string_lossy()
                    .to_string();
                let mut to = resolve(&dest, &fname);
                if to.exists() {
                    let stem = from
                        .file_stem()
                        .map(|f| f.to_string_lossy().to_string())
                        .unwrap_or("file".into());
                    let ext = from
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                        .unwrap_or_default();
                    let mut i = 2;
                    while to.exists() {
                        to = dest_dir.join(format!("{stem} ({i}){ext}"));
                        i += 1;
                    }
                }
                copy_recursive(&from, &to).await?;
            }
            Ok(format!("copied {} item(s)", srcs.len()))
        }
        "move" => {
            let dest = dest.ok_or("missing dest")?;
            let dest_dir = PathBuf::from(&dest);
            if !dest_dir.is_dir() {
                return Err("dest is not a directory".into());
            }
            for src in &srcs {
                let from = PathBuf::from(src);
                if from.is_dir() && (dest_dir.starts_with(&from) || dest_dir == from) {
                    return Err("cannot move into itself".into());
                }
                let name = from
                    .file_name()
                    .ok_or("bad src")?
                    .to_string_lossy()
                    .to_string();
                let to = resolve(&dest, &name);
                if from.parent() == Some(dest_dir.as_path()) {
                    continue; // same folder, no-op
                }
                if to.exists() {
                    return Err(format!("{name} already exists in destination"));
                }
                match tokio::fs::rename(&from, &to).await {
                    Ok(()) => {}
                    Err(_) => {
                        // Cross-device fallback: copy + delete.
                        copy_recursive(&from, &to).await?;
                    }
                }
                let _ = tokio::fs::remove_dir_all(&from).await;
                let _ = tokio::fs::remove_file(&from).await;
            }
            Ok(format!("moved {} item(s)", srcs.len()))
        }
        "delete" => {
            let mut n = 0;
            for src in &srcs {
                let from = PathBuf::from(src);
                // Trash first; fall back to a hard delete only if the
                // platform has no trash available.
                if trash::delete(&from).is_err() {
                    if from.is_dir() {
                        tokio::fs::remove_dir_all(&from)
                            .await
                            .map_err(|e| e.to_string())?;
                    } else {
                        tokio::fs::remove_file(&from)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
                n += 1;
            }
            Ok(format!("deleted {n} item(s)"))
        }
        other => Err(format!("unknown op: {other}")),
    }
}

async fn copy_recursive(from: &Path, to: &Path) -> Result<(), String> {
    if from.is_dir() {
        tokio::fs::create_dir_all(to)
            .await
            .map_err(|e| e.to_string())?;
        let mut rd = tokio::fs::read_dir(from).await.map_err(|e| e.to_string())?;
        while let Some(entry) = rd.next_entry().await.map_err(|e| e.to_string())? {
            let child_to = to.join(entry.file_name());
            Box::pin(copy_recursive(&entry.path(), &child_to)).await?;
        }
        Ok(())
    } else {
        tokio::fs::copy(from, to)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}
