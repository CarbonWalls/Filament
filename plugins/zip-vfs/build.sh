#!/usr/bin/env bash
# Build the zip-vfs plugin and place the artifact where the daemon looks:
#   plugins/zip-vfs/plugin.wasm   (next to plugin.toml)
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"

cargo build --manifest-path "$here/crate/Cargo.toml" \
  --target wasm32-unknown-unknown --release

cp "$here/crate/target/wasm32-unknown-unknown/release/zip_vfs_plugin.wasm" \
   "$here/plugin.wasm"

ls -l "$here/plugin.wasm"
