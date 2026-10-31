use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// Embeds the compiled frontend (`web/dist`) into the binary so a single
/// executable serves everything.
#[derive(RustEmbed)]
#[folder = "web/dist"]
struct Assets;

/// Bytes served for a path, transparently using the build-time gzip twin when
/// the client accepts it. Precompressing at build time means the daemon never
/// spends CPU on compression and the embedded assets stay immutable.
fn compressed_or_raw(path: &str, headers: &HeaderMap) -> Option<(Vec<u8>, bool)> {
    let accepts_gzip = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("gzip"))
        .unwrap_or(false);
    if accepts_gzip {
        if let Some(gz) = Assets::get(&format!("{path}.gz")) {
            return Some((gz.data.to_vec(), true));
        }
    }
    Assets::get(path).map(|f| (f.data.to_vec(), false))
}

pub async fn serve(uri: Uri, headers: HeaderMap) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match compressed_or_raw(path, &headers) {
        Some((bytes, gzipped)) => asset_response(path, bytes, gzipped),
        None => {
            // SPA fallback: unknown non-asset paths serve index.html.
            if !path.contains('.') {
                if let Some(index) = Assets::get("index.html") {
                    return (
                        [
                            (header::CONTENT_TYPE, "text/html".to_string()),
                            (header::CACHE_CONTROL, "no-cache".to_string()),
                        ],
                        index.data.to_vec(),
                    )
                        .into_response();
                }
            }
            (StatusCode::NOT_FOUND, "not found").into_response()
        }
    }
}

fn asset_response(path: &str, bytes: Vec<u8>, gzipped: bool) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let cache = if path.starts_with("assets/") || path.starts_with("fonts/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    let mut res = (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, cache.to_string()),
            (header::VARY, "accept-encoding".to_string()),
        ],
        bytes,
    )
        .into_response();
    if gzipped {
        res.headers_mut()
            .insert(header::CONTENT_ENCODING, "gzip".parse().unwrap());
    }
    res
}
