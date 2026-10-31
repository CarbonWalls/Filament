use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

fn cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("filament")
        .join("thumbs")
}

fn etag_for(path: &str, mtime: u64, size: u64, px: u32) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    mtime.hash(&mut h);
    size.hash(&mut h);
    px.hash(&mut h);
    format!("\"{:016x}\"", h.finish())
}

/// GET /api/thumb?path=…&size=256
/// Content-addressed thumbnail cache served as immutable.
pub async fn thumb(
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let Some(path) = q.get("path") else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    let px: u32 = q
        .get("size")
        .and_then(|s| s.parse().ok())
        .unwrap_or(256)
        .clamp(32, 512);
    let pb = PathBuf::from(path);
    let Ok(meta) = std::fs::metadata(&pb) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    if meta.is_dir() {
        return (StatusCode::BAD_REQUEST, "is a directory").into_response();
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let etag = etag_for(path, mtime, meta.len(), px);
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains(&etag))
        .unwrap_or(false)
    {
        return (StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response();
    }

    let key = etag.trim_matches('"').to_string();
    let cache_file = cache_dir().join(format!("{key}.png"));
    let bytes = match std::fs::read(&cache_file) {
        Ok(bytes) => bytes,
        Err(_) => {
            let src = pb.clone();
            let dst = cache_file.clone();
            match tokio::task::spawn_blocking(move || generate(&src, &dst, px)).await {
                Ok(Ok(bytes)) => bytes,
                _ => return (StatusCode::UNPROCESSABLE_ENTITY, "no thumbnail").into_response(),
            }
        }
    };

    (
        [
            (header::CONTENT_TYPE, "image/png".to_string()),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable".to_string(),
            ),
            (header::ETAG, etag),
        ],
        bytes,
    )
        .into_response()
}

fn generate(src: &PathBuf, dst: &PathBuf, px: u32) -> Result<Vec<u8>, String> {
    let img = image::open(src).map_err(|e| e.to_string())?;
    let thumb = img.resize(px, px, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    thumb
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(dst.parent().unwrap());
    let _ = std::fs::write(dst, &out);
    Ok(out)
}

/// GET /api/file?path=… — raw bytes (supports archive paths `a.zip!/inner`).
pub async fn read_file(
    State(app): State<crate::state::AppState>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let Some(path) = q.get("path") else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    let pb = PathBuf::from(path);
    if pb.is_dir() {
        return (StatusCode::BAD_REQUEST, "is a directory").into_response();
    }
    let bytes = match crate::list::split_archive(path) {
        Some((archive, inner)) => match app.0.plugins.plugin_read(&archive, &inner) {
            Ok(b) => b,
            Err(e) => return (StatusCode::UNPROCESSABLE_ENTITY, e).into_response(),
        },
        None => match tokio::fs::read(&pb).await {
            Ok(b) => b,
            Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
        },
    };
    let mime_owned = mime_guess::from_path(path).first_or_octet_stream().essence_str().to_string();
    let mime = mime_owned.as_str();
    let etag = {
        let mut h = DefaultHasher::new();
        path.hash(&mut h);
        bytes.len().hash(&mut h);
        format!("\"{:016x}\"", h.finish())
    };
    (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::ETAG, etag.clone()),
            (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
        ],
        bytes,
    )
        .into_response()
}

/// GET /api/preview?path=…&max=65536 — head bytes + metadata for the preview pane.
pub async fn preview(
    State(app): State<crate::state::AppState>,
    axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>,
) -> Response {
    let Some(path) = q.get("path") else {
        return (StatusCode::BAD_REQUEST, "missing path").into_response();
    };
    let max: usize = q
        .get("max")
        .and_then(|m| m.parse().ok())
        .unwrap_or(64 * 1024)
        .min(1024 * 1024);
    let pb = PathBuf::from(path);
    if pb.is_dir() {
        return (StatusCode::BAD_REQUEST, "is a directory").into_response();
    }
    let meta = match std::fs::metadata(&pb) {
        Ok(m) => m,
        Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    };
    let mime = mime_guess::from_path(&pb)
        .first_or_octet_stream()
        .essence_str()
        .to_string();
    let is_text = mime.starts_with("text/")
        || matches!(
            mime.as_str(),
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/x-yaml"
                | "application/toml"
        )
        || mime == "image/svg+xml";

    let head: Vec<u8> = match crate::list::split_archive(path) {
        Some((archive, inner)) => app
            .0
            .plugins
            .plugin_read(&archive, &inner)
            .map(|mut b| {
                b.truncate(max);
                b
            })
            .unwrap_or_default(),
        None => {
            let f = tokio::fs::File::open(&pb).await;
            match f {
                Ok(mut f) => {
                    use tokio::io::AsyncReadExt;
                    let mut buf = vec![0u8; max];
                    let n = f.read(&mut buf).await.unwrap_or(0);
                    buf.truncate(n);
                    buf
                }
                Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
            }
        }
    };
    let truncated = meta.len() > head.len() as u64;

    axum::Json(json!({
        "mime": mime,
        "isText": is_text,
        "size": meta.len(),
        "truncated": truncated,
        "head": String::from_utf8_lossy(&head),
    }))
    .into_response()
}
