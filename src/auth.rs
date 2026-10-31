use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use rand::RngCore;
use serde_json::json;

pub const COOKIE: &str = "fm_sid";

pub fn gen_token() -> String {
    let mut b = [0u8; 18];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn cookie_from(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let mut kv = part.trim().splitn(2, '=');
        if kv.next()? == COOKIE {
            return kv.next().map(|v| v.to_string());
        }
    }
    None
}

/// True when the request carries the session cookie issued by /auth.
pub fn authed(headers: &HeaderMap, token: &str) -> bool {
    cookie_from(headers).as_deref() == Some(token)
}

/// GET /auth?token=… — the only way to obtain the session cookie.
/// The token is printed by the daemon at startup (and embedded in the URL it opens).
pub async fn auth(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
    axum::Extension(state): axum::Extension<crate::state::AppState>,
) -> Response {
    if q.get("token").map(|t| *t == state.0.token).unwrap_or(false) {
        let cookie = format!(
            "{COOKIE}={}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800",
            state.0.token
        );
        (
            StatusCode::FOUND,
            [(header::SET_COOKIE, cookie)],
            Redirect::to("/"),
        )
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            [(header::CONTENT_TYPE, "text/html")],
            "<meta charset=utf-8><body style='font:14px system-ui;background:#101314;color:#e6e8e9;display:grid;place-items:center;height:100dvh'>Filament: invalid token. Launch from the shell: <code>filament --open</code></body>",
        )
            .into_response()
    }
}

/// JSON error helper used by guarded routes.
pub fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        axum::Json(json!({"err": "unauthorized"})),
    )
        .into_response()
}
