use crate::db::Db;
use crate::plugins::Registry;
use crate::watch::WatchHub;
use std::sync::Arc;

/// Shared daemon state handed to every handler.
#[derive(Clone)]
pub struct AppState(pub Arc<Inner>);

pub struct Inner {
    pub token: String,
    pub started: std::time::Instant,
    /// Debug-only artificial listing delay (ms). Non-zero only with
    /// `--slow <ms> --allow-debug`: it exists so the loading states can be
    /// photographed on a fast local disk. It is never enabled by default.
    pub slow_ms: std::sync::atomic::AtomicU64,
    pub allow_debug: bool,
    pub watch: WatchHub,
    pub db: Db,
    pub plugins: Registry,
}

impl AppState {
    pub fn init(token: String, slow_ms: u64, allow_debug: bool) -> Self {
        let watch = WatchHub::new();
        let db = Db::open();
        let plugins = Registry::load();
        AppState(Arc::new(Inner {
            token,
            started: std::time::Instant::now(),
            slow_ms: std::sync::atomic::AtomicU64::new(slow_ms),
            allow_debug,
            watch,
            db,
            plugins,
        }))
    }
}
