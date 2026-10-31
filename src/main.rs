mod api;
mod auth;
mod db;
mod fsapi;
mod list;
mod ops;
mod plugins;
mod search;
mod state;
mod static_assets;
mod watch;
mod wasmhost;
mod ws;

use axum::http::{header, HeaderValue};
use state::AppState;
use std::net::SocketAddr;

#[tokio::main]
async fn main() {
    let mut port: Option<u16> = None;
    let mut open_browser = false;
    let mut slow_ms: u64 = 0;
    let mut allow_debug = false;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "serve" => {}
            "--open" => open_browser = true,
            "--no-open" => open_browser = false,
            "--port" => port = args.next().and_then(|s| s.parse().ok()),
            "--slow" => slow_ms = args.next().and_then(|s| s.parse().ok()).unwrap_or(0),
            "--allow-debug" => allow_debug = true,
            _ => {}
        }
    }

    let token = auth::gen_token();
    let app = AppState::init(token, slow_ms, allow_debug);

    let router = api::router(app.clone());
    let addr = SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind 127.0.0.1 (local-only by design)");
    let bound = listener.local_addr().unwrap().port();
    let url = format!("http://127.0.0.1:{bound}/auth?token={}", app.0.token);
    eprintln!(
        "filament {} ready in {} ms → {}",
        env!("CARGO_PKG_VERSION"),
        app.0.started.elapsed().as_millis(),
        url
    );
    println!("{url}");

    if open_browser {
        let url_open = url.clone();
        tokio::spawn(async move {
            #[cfg(target_os = "windows")]
            let _ = tokio::process::Command::new("cmd").args(["/C", "start", &url_open]).spawn();
            #[cfg(target_os = "macos")]
            let _ = tokio::process::Command::new("open").arg(&url_open).spawn();
            #[cfg(all(unix, not(target_os = "macos")))]
            let _ = tokio::process::Command::new("xdg-open").arg(&url_open).spawn();
        });
        // The opener is best-effort: a headless box, or Chromium running as
        // root without --no-sandbox, will silently refuse to show a window.
        // Say so instead of leaving the user staring at a terminal.
        eprintln!(
            "tried to open your browser — if nothing appeared (headless session, or \
             Chromium refusing to run as root), paste the URL above yourself."
        );
    }

    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
