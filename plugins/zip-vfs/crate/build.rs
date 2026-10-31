//! Linker configuration for the WASM target.
//!
//! The plugin imports `env.host`, which only exists at runtime (the daemon
//! provides it). `wasm-ld` errors on undefined symbols by default, so we pass
//! `--allow-undefined`, which turns `host` into an import from the `env`
//! module instead of a hard link error.
//!
//! Expressing this as a link argument (rather than `RUSTFLAGS` or a
//! `.cargo/config.toml`) means a plain
//! `cargo build --target wasm32-unknown-unknown --release` works from any
//! working directory.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    if arch == "wasm32" {
        println!("cargo:rustc-link-arg=--allow-undefined");
    }
}
