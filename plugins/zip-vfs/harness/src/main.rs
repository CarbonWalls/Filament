//! Host-side integration harness for `zip-vfs`.
//!
//! It links the daemon's *real* wasm host module (`src/wasmhost.rs`, included
//! by path) and drives the plugin exactly as the daemon does — `Plugin::load`
//! → `instantiate(capabilities)` → `set_archive` → `call(line_record)` — while
//! comparing every inflated byte against an independent reference decoder
//! (Python's `zipfile`, i.e. zlib).
//!
//! Usage:
//!   cargo run --manifest-path plugins/zip-vfs/harness/Cargo.toml -- \
//!       plugins/zip-vfs/plugin.wasm demo/kit.zip
//!
//! Exit code 0 = every assertion passed.

#[path = "../../../../src/wasmhost.rs"]
mod wasmhost;

use std::collections::HashSet;
use std::process::Command;

struct Report {
    pass: usize,
    fail: usize,
}

impl Report {
    fn check(&mut self, name: &str, ok: bool, detail: &str) {
        if ok {
            self.pass += 1;
            println!("  \x1b[32m✓\x1b[0m {name}{}", if detail.is_empty() { String::new() } else { format!(" \x1b[2m{detail}\x1b[0m") });
        } else {
            self.fail += 1;
            println!("  \x1b[31m✗ {name}\x1b[0m {detail}");
        }
    }
}

/// Independent reference: sha256 + length of an entry, decoded by Python's zlib.
fn reference(archive: &str, entry: &str) -> (String, usize) {
    let code = "import sys,zipfile,hashlib;z=zipfile.ZipFile(sys.argv[1]);\
                d=z.read(sys.argv[2]);print(hashlib.sha256(d).hexdigest(), len(d))";
    let out = Command::new("python3")
        .args(["-c", code, archive, entry])
        .output()
        .expect("run python3 (needed as the reference zip decoder)");
    assert!(out.status.success(), "python3 reference failed for {entry}");
    let s = String::from_utf8_lossy(&out.stdout);
    let mut it = s.trim().split(' ');
    (
        it.next().unwrap_or_default().to_string(),
        it.next().unwrap_or("0").parse().unwrap_or(0),
    )
}

fn sha256_hex(data: &[u8]) -> String {
    // Tiny FIPS-180 SHA-256 so the harness stays dependency-free.
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bitlen = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bitlen.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

/// Diagnostics for a failed `Module::from_file`.
///
/// rustc's wasm32-unknown-unknown target enables the reference-types proposal,
/// so LLVM encodes `call_indirect`'s table index as a LEB (`80 80 80 80 00`)
/// rather than the MVP's single zero byte. wasmtime 24 only accepts that when
/// it is built with its `gc` cargo feature, because `Config::default()` sets
/// `WasmFeatures::REFERENCE_TYPES = cfg!(feature = "gc")` and the
/// `wasm_reference_types()` setter is itself `#[cfg(feature = "gc")]`. Without
/// it, *every* rustc-produced module is rejected with
/// "Invalid input WebAssembly code at offset N: zero byte expected".
fn diagnose_load_failure(wasm: &str) {
    let Ok(data) = std::fs::read(wasm) else { return };
    let pattern = [0x11u8, 0x80, 0x80, 0x80, 0x80, 0x00, 0x80, 0x80, 0x80, 0x80, 0x00];
    let sites = data.windows(pattern.len()).filter(|w| *w == pattern).count();
    println!("     module has {sites} call_indirect site(s) with LEB-encoded table indices");
    println!(
        "     \x1b[33mfix: the host's wasmtime needs the `gc` cargo feature \
         (features = [\"cranelift\", \"runtime\", \"gc\"]) — see Cargo.toml\x1b[0m"
    );
}

/// Body after the `ok\n` status line, or an Err with the plugin's message.
fn ok_body(resp: &[u8]) -> Result<&[u8], String> {
    if let Some(rest) = resp.strip_prefix(&b"ok\n"[..]) {
        Ok(rest)
    } else {
        let msg = resp
            .strip_prefix(&b"err\n"[..])
            .map(|m| String::from_utf8_lossy(m).trim().to_string())
            .unwrap_or_else(|| String::from_utf8_lossy(resp).to_string());
        Err(msg)
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let wasm = args.next().unwrap_or_else(|| "plugins/zip-vfs/plugin.wasm".into());
    let archive = args.next().unwrap_or_else(|| "demo/kit.zip".into());
    let mut rep = Report { pass: 0, fail: 0 };

    println!("\n\x1b[1mzip-vfs harness\x1b[0m  {wasm}  {archive}\n");

    // 1. Load exactly as the daemon does.
    let plugin = match wasmhost::Plugin::load(std::path::Path::new(&wasm)) {
        Ok(p) => p,
        Err(e) => {
            println!("\x1b[31mFATAL: Plugin::load failed:\x1b[0m {e}");
            // The daemon's error string is the top-level message only; show the
            // full cause chain here so ABI/engine mismatches are diagnosable.
            match wasmtime::Module::from_file(&wasmtime::Engine::default(), std::path::Path::new(&wasm)) {
                Ok(_) => {}
                Err(detail) => println!("\x1b[31mfull wasmtime error:\x1b[0m {detail:?}"),
            }
            diagnose_load_failure(&wasm);
            std::process::exit(1);
        }
    };
    rep.check("Plugin::load", true, "");

    // 2. Instantiate with only the declared capability.
    let mut inst = match plugin.instantiate(vec!["fs:read".into()]) {
        Ok(i) => i,
        Err(e) => {
            println!("\x1b[31mFATAL: instantiate failed:\x1b[0m {e}");
            std::process::exit(1);
        }
    };
    rep.check("instantiate with [fs:read]", true, "");

    // 3. Capability enforcement: without an archive context, reads are denied.
    inst.set_archive(None);
    let denied = inst.call(&format!("list\t{archive}\t"));
    rep.check(
        "no archive context → capability denied",
        matches!(&denied, Ok(b) if b.starts_with(b"err\n")),
        &format!("{:?}", denied.map(|b| String::from_utf8_lossy(&b).to_string())),
    );

    // 3b. Capability enforcement: a plugin instantiated *without* `fs:read`
    // cannot reach the filesystem at all, even with an archive context set.
    match plugin.instantiate(vec![]) {
        Ok(mut no_caps) => {
            no_caps.set_archive(Some(archive.clone()));
            let r = no_caps.call(&format!("list\t{archive}\t"));
            rep.check(
                "instantiated without fs:read → host refuses the read",
                matches!(&r, Ok(b) if b.starts_with(b"err\n")),
                &format!("{:?}", r.map(|b| String::from_utf8_lossy(&b).to_string())),
            );
        }
        Err(e) => rep.check("instantiate with no capabilities", false, &e),
    }

    // 4. List the archive root.
    inst.set_archive(Some(archive.clone()));
    let t0 = std::time::Instant::now();
    let root = match inst.call(&format!("list\t{archive}\t")) {
        Ok(resp) => match ok_body(&resp) {
            Ok(body) => {
                let ms = t0.elapsed().as_millis();
                rep.check("list archive root", true, &format!("{ms}ms"));
                String::from_utf8_lossy(body).to_string()
            }
            Err(e) => {
                rep.check("list archive root", false, &e);
                String::new()
            }
        },
        Err(e) => {
            rep.check("list archive root", false, &e);
            String::new()
        }
    };
    let names: Vec<&str> = root
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| l.split('\t').next().unwrap_or(""))
        .collect();
    let mut sorted = names.clone();
    sorted.sort_unstable();
    rep.check(
        "root shape",
        sorted == ["assets", "data", "readme.md", "src"],
        &format!("{names:?}"),
    );
    rep.check(
        "hostile entries absent",
        !names.iter().any(|n| n.contains("evil") || n.starts_with("abs")),
        "('../evil.txt', '/abs.txt' skipped)",
    );

    // 5. Nested listing + de-duplication of implicit vs explicit dir entries.
    let src = inst
        .call(&format!("list\t{archive}\tsrc"))
        .and_then(|b| Ok(ok_body(&b)?.to_vec()))
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let mut src_names: Vec<&str> = src.lines().filter(|l| !l.is_empty()).map(|l| l.split('\t').next().unwrap_or("")).collect();
    src_names.sort_unstable();
    rep.check("nested list src/", src_names == ["lib.rs", "main.rs", "util"], &format!("{src_names:?}"));

    let util = inst
        .call(&format!("list\t{archive}\tsrc/util"))
        .and_then(|b| Ok(ok_body(&b)?.to_vec()))
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default();
    let mut util_names: Vec<&str> = util.lines().filter(|l| !l.is_empty()).map(|l| l.split('\t').next().unwrap_or("")).collect();
    util_names.sort_unstable();
    rep.check("nested list src/util/", util_names == ["helper.rs", "mod.rs"], &format!("{util_names:?}"));

    // 6. Read every file the listing advertised, and compare to zlib.
    let mut checked = HashSet::new();
    let dirs = ["", "src", "src/util", "assets", "assets/img", "data"];
    for dir in dirs {
        let listing = inst
            .call(&format!("list\t{archive}\t{dir}"))
            .and_then(|b| Ok(ok_body(&b)?.to_vec()))
            .map(|b| String::from_utf8_lossy(&b).to_string())
            .unwrap_or_default();
        for line in listing.lines().filter(|l| !l.is_empty()) {
            let mut f = line.split('\t');
            let name = f.next().unwrap_or("");
            let kind: u8 = f.next().and_then(|k| k.parse().ok()).unwrap_or(0);
            if kind != 0 {
                continue;
            }
            let inner = if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") };
            if !checked.insert(inner.clone()) {
                continue;
            }
            let (want_hash, want_len) = reference(&archive, &inner);
            match inst.call(&format!("read\t{archive}\t{inner}")) {
                Ok(resp) => match ok_body(&resp) {
                    Ok(bytes) => {
                        let got = sha256_hex(bytes);
                        rep.check(
                            &format!("read {inner}"),
                            got == want_hash && bytes.len() == want_len,
                            &format!("{} bytes, sha256 {}…", bytes.len(), &got[..12]),
                        );
                    }
                    Err(e) => rep.check(&format!("read {inner}"), false, &e),
                },
                Err(e) => rep.check(&format!("read {inner}"), false, &e),
            }
        }
    }
    rep.check("read every advertised file", checked.len() >= 10, &format!("{} files", checked.len()));

    // 7. Traversal + missing-entry rejection.
    for bad in ["../evil.txt", "/abs.txt", "src/nope.rs", "..", ""] {
        let r = inst.call(&format!("read\t{archive}\t{bad}"));
        let is_err = matches!(&r, Ok(b) if b.starts_with(b"err\n"));
        rep.check(&format!("read {bad:?} rejected"), is_err, "plugin returned err");
    }

    // 8. Unsupported compression method is reported, not silently ignored.
    //    (built on the fly by the caller via make_unsupported_zip.py)

    println!(
        "\n\x1b[1m{}  {} passed, {} failed\x1b[0m\n",
        if rep.fail == 0 { "\x1b[32mALL PASS" } else { "\x1b[31mFAILURES" },
        rep.pass,
        rep.fail
    );
    std::process::exit(if rep.fail == 0 { 0 } else { 1 });
}
