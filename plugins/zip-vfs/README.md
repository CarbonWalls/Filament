# zip-vfs — Filament backend plugin

Mounts `.zip` archives as folders: `/home/me/kit.zip!/src` lists like a
directory, and files inside are readable through the same preview/read paths as
real files.

Zero dependencies, offline build, ~56 KB of WebAssembly. The ZIP reader and the
RFC 1951 (raw DEFLATE) inflater are both written from scratch — no `flate2`, no
`zip`, no `miniz_oxide`.

```
plugins/zip-vfs/
├── plugin.toml          # capability manifest the daemon reads
├── plugin.wasm          # build artifact (copied by build.sh)
├── build.sh             # cargo build --target wasm32-unknown-unknown --release
├── .cargo/config.toml   # guest feature pinning (see "Host requirements")
├── crate/               # the wasm crate (zero deps, cdylib)
│   ├── Cargo.toml
│   ├── build.rs         # --allow-undefined, so the env.host import links
│   └── src/lib.rs       # ZIP parser + inflater + plugin entry points
├── harness/             # host-side integration harness (links src/wasmhost.rs)
│   └── src/main.rs
└── test/
    ├── make_kit_zip.py       # fixture generator (zipfile, ZIP_DEFLATED)
    └── ws_integration.mjs    # end-to-end test through the running daemon
```

## Manifest

```toml
id = "zip-vfs"
version = "0.1.0"
capabilities = ["fs:read"]
hooks = ["list", "read"]
matches = ["*.zip"]
```

The only capability requested is `fs:read`, and the host grants it *per call*:
`HostState::current_archive` is set to the archive being browsed, and any
`read_file` for a different path is refused. The plugin therefore cannot wander
the filesystem even if it is compromised.

## ABI

| Direction | Shape |
|---|---|
| exports | `memory`, `alloc(len: i32) -> i32`, `handle(ptr: i32, len: i32) -> i32` |
| imports | `env.host(ptr: i32, len: i32) -> i32` |
| request to `handle` | raw UTF-8 line record |
| anything *returned* | 4-byte little-endian length header + body |

Protocol:

```text
list\t<archive>\t<inner_dir>   ->  ok\n<name>\t<kind>\t<size>\n…
read\t<archive>\t<inner_file>  ->  ok\n<raw inflated bytes>
anything that fails            ->  err\n<message>\n
```

`kind` is `0` = file, `1` = directory. Names are relative to `inner_dir`, so a
child of the browsed directory never contains `/`; implicit directories (from
deeper paths) are merged with explicit directory entries, which is why
`src/util` appears exactly once even though the fixture archive contains both
`src/util/` and `src/util/mod.rs`.

Guest side, the plugin fetches archive bytes with:

```text
read_file\n<archive_path>\n
```

## Build

```sh
./build.sh
# or, equivalently:
cargo build --target wasm32-unknown-unknown --release   # from crate/
```

`plugins/zip-vfs/crate/build.rs` emits `--allow-undefined` so `wasm-ld` turns
the unresolved `env.host` symbol into an import instead of failing the link.

## Test

Both suites need the host fix described below.

```sh
# 1. host-side harness: real src/wasmhost.rs + wasmtime, byte-compares every
#    entry against Python's zlib by sha256
CARGO_TARGET_DIR=/root/filament/target \
  cargo run --manifest-path plugins/zip-vfs/harness/Cargo.toml -- \
  plugins/zip-vfs/plugin.wasm demo/kit.zip

# 2. end-to-end through the running daemon: boots target/debug/filament on a
#    random port, exchanges the /auth token for the cookie, drives /ws
npm install ws --prefix /tmp/fwstest
NODE_PATH=/tmp/fwstest/node_modules node plugins/zip-vfs/test/ws_integration.mjs
```

The fixture (`python3 plugins/zip-vfs/test/make_kit_zip.py`) writes
`demo/kit.zip` with a nested tree plus deliberately awkward payloads:

| Entry | What it proves |
|---|---|
| `readme.md`, `src/main.rs`, `src/lib.rs`, `src/util/*`, `assets/*` | nested listing and reads |
| `assets/` and `src/util/` dir entries | de-duplication against implicit directories |
| `data/stored.bin` (method 0) | stored entries are served verbatim |
| `data/blob.bin` (8 KB random) | deflate *stored* blocks, byte alignment after the 3-bit header |
| `data/bigrandom.bin` (200 KB random) | multiple stored blocks in one stream |
| `data/mixed.bin` | dynamic-Huffman block followed by stored blocks |
| `data/repetitive.txt` (202 KB) | dynamic Huffman + long back-references (32 KB window) |
| `data/pseudorandom.txt` (64 KB) | literal-heavy blocks |
| `data/empty.txt` | zero-length entry |
| `../evil.txt`, `/abs.txt` | traversal / absolute names are skipped at parse time |
| `kit-encrypted.zip` | encryption flag → explicit refusal |

## Host requirements (important)

**The daemon's `wasmtime` dependency must enable its `gc` cargo feature** — see
`/root/filament/Cargo.toml`. Without it the plugin (and every other
rustc-produced wasm module) is rejected at load time:

```text
plugin 'zip-vfs' failed to load: wasm load failed: WebAssembly translation error
Caused by: Invalid input WebAssembly code at offset 28094: zero byte expected
```

Reason: `wasmtime 24` sets `WasmFeatures::REFERENCE_TYPES = cfg!(feature = "gc")`
in `Config::default()`, and `Config::wasm_reference_types()` is itself
`#[cfg(feature = "gc")]`, so it cannot be re-enabled at runtime. rustc enables
reference types on `wasm32-unknown-unknown`, which makes LLVM encode
`call_indirect`'s table index as a LEB (`80 80 80 80 00`) instead of the MVP's
single `00` byte; the reference-types-disabled parser reads that position as a
strict reserved byte and errors out. This is not fixable from the guest: build
flags that disable the `reference-types` target feature do not change LLVM's
`call_indirect` encoding (verified — the module is byte-identical either way).

`gc` restores reference-types *parsing* only; GC and function-references stay
disabled because wasmparser defaults them off and wasmtime only forces them off
when the cargo feature is missing.

## Not supported (deliberate)

* **Encryption** — entries with the encryption bit set are refused with
  `encrypted entries are not supported` rather than decoded as garbage.
* **Zip64 is parsed but not exercised**: the EOCD64 locator and the zip64
  extended-information field are read (so >4 GB offsets/sizes decode), but no
  >4 GB archive was available to test against. Archives that need zip64 are
  therefore best described as "should work, untested".
* **Multi-disk/split archives** — the disk fields are ignored; only
  single-file archives are supported.
* **Compression methods** other than `0` (stored) and `8` (deflate) are
  rejected by name, e.g. `unsupported compression method 12` (bzip2).
* **CRC-32 verification** is performed whenever the entry's stored CRC is
  non-zero; a mismatch is reported as an error instead of returning corrupt
  bytes.
* **Zip-bomb limits**: at most 64 MB inflated per entry and 512 MB per archive.
* Entries carry no mtime in the listing (the daemon's virtual entries get
  `mtime: 0`).

## Implementation notes

* **Central-directory driven**: listing reads only the central directory; the
  local header is consulted per read to locate the payload, so a 200 KB entry
  costs nothing to list.
* **Inflate** is `puff`-style: canonical Huffman tables built from code lengths
  (`count`/`symbol`/`first`/`index`), LSB-first bit reader, block types 0/1/2,
  and a byte-by-byte match copy so overlapping back-references work without a
  separate window buffer.
* **An incomplete Huffman code is tolerated** (only over-subscribed is an
  error): the fixed distance table is legitimately incomplete.
* The stored-block path aligns to a byte boundary *before* reading `LEN`/`NLEN`.
  Getting this wrong is silent — it surfaced as `stored block length check
  failed` on `data/blob.bin`, which is exactly the bug this fixture exists to
  catch.
