use crate::auth;
use crate::state::AppState;
use axum::http::{header, HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};

/// Session guard: everything except /auth requires the cookie issued once by
/// /auth?token=… (printed by the daemon at startup). SameSite=Strict means
/// cross-site requests never carry it — that is the CSRF story.
async fn require_session(
    Extension(app): Extension<AppState>,
    req: Request<axum::body::Body>,
    next: Next,
) -> Response {
    if auth::authed(req.headers(), &app.0.token) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, "unauthorized — launch filament from the shell").into_response()
    }
}

async fn add_security_headers(req: Request<axum::body::Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    res.headers_mut().insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    res.headers_mut().insert(
        header::HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    res
}

pub fn router(app: AppState) -> Router {
    // Protected surface: static shell, WS, and the read-only HTTP helpers.
    let protected = Router::new()
        .route("/", get(crate::static_assets::serve))
        .route("/*path", get(crate::static_assets::serve))
        .route("/ws", get(crate::ws::ws_route))
        .route("/api/file", get(crate::fsapi::read_file))
        .route("/api/preview", get(crate::fsapi::preview))
        .route("/api/thumb", get(crate::fsapi::thumb))
        .route("/api/home", get(home_json))
        .layer(middleware::from_fn_with_state(app.clone(), require_session));

    // The only unauthenticated route: exchanging the one-time token for a
    // session cookie.
    let open = Router::new().route("/auth", get(crate::auth::auth));

    protected
        .merge(open)
        .fallback(not_found)
        .layer(middleware::from_fn(add_security_headers))
        .layer(Extension(app.clone()))
        .with_state(app)
}

async fn home_json(Extension(app): Extension<AppState>) -> Response {
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/".to_string());
    let _ = &app;
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "home": home }).to_string(),
    )
        .into_response()
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}
