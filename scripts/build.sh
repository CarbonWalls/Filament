#!/usr/bin/env bash
# One-shot production build.
#
#   1. build the UI (Vite → web/dist)
#   2. pre-compress every text asset, so the daemon never compresses at runtime
#      and cold loads transfer roughly a third of the bytes
#   3. build the daemon (rust-embed bakes web/dist — including the .gz twins)
#
# The daemon embeds whatever is in web/dist at *compile* time, so steps 1–2
# must run before 3. This script exists so that ordering can never be
# forgotten.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── ui ────────────────────────────────────────────"
(cd web && npm install --no-audit --no-fund --silent && npm run build)

echo "── precompress ───────────────────────────────────"
find web/dist \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
  -o -name '*.json' -o -name '*.webmanifest' \) -print0 |
  while IFS= read -r -d '' f; do
    gzip -9 -k -f -n "$f"
  done
find web/dist -name '*.gz' | wc -l | xargs echo "  gzip twins:"
du -sh web/dist | xargs echo "  dist size:"

echo "── daemon ────────────────────────────────────────"
cargo build --release

echo
ls -lh target/release/filament | awk '{print "binary: " $5 "  " $9}'
