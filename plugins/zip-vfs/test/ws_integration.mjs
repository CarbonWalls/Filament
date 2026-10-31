#!/usr/bin/env node
/**
 * End-to-end test for the zip-vfs plugin, driven through the real daemon.
 *
 *   node plugins/zip-vfs/test/ws_integration.mjs [path/to/filament]
 *
 * It boots `filament` on a random loopback port, exchanges the one-time token
 * from /auth for the session cookie, opens the real /ws endpoint (so the
 * plugin-registry → wasmtime → plugin path is exercised exactly as the UI uses
 * it), and then:
 *   1. asserts the plugin registry loaded zip-vfs,
 *   2. lists directories *inside* the archive over the WebSocket `list` RPC,
 *   3. reads files out of the archive over HTTP (deflate + stored),
 *   4. checks the inflated bytes against an independent reference decoder
 *      (Python's zipfile/zlib) by sha256,
 *   5. proves the `..`/absolute entries are neither listed nor readable,
 *   6. proves the cookie gate rejects unauthenticated requests.
 *
 * `ws` is used only because the standard Node WebSocket cannot set a Cookie
 * header on the handshake; install it with:
 *   npm install ws --prefix /tmp/fwstest && NODE_PATH=/tmp/fwstest/node_modules node ...
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let WebSocketImpl;
try {
  WebSocketImpl = require("ws");
} catch {
  try {
    WebSocketImpl = require("/tmp/fwstest/node_modules/ws");
  } catch {
    console.error("FATAL: `ws` not found. npm install ws --prefix /tmp/fwstest");
    process.exit(2);
  }
}

const ROOT = "/root/filament";
const ZIP = process.env.KIT_ZIP || `${ROOT}/demo/kit.zip`;
const ARCHIVE = `${ZIP}!/`;
const BIN = process.argv[2] || `${ROOT}/target/release/filament`;

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[2m${detail}\x1b[0m` : ""}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`);
  }
};

async function bootDaemon() {
  const child = spawn(BIN, ["--port", "0"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const url = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?token=[0-9a-f]+/);
      if (m) resolve(m[0]);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("daemon did not print its URL in 20s")), 20000);
  });
  return { child, url };
}

/** Exchange the one-time token for the session cookie. */
async function authenticate(url) {
  const res = await fetch(url, { redirect: "manual" });
  const raw = res.headers.getSetCookie
    ? res.headers.getSetCookie().join(";")
    : res.headers.get("set-cookie");
  const cookie = (raw || "").split(";")[0];
  if (!/^fm_sid=[0-9a-f]+$/.test(cookie)) throw new Error(`bad cookie: ${raw}`);
  return cookie;
}

class Rpc {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.frames = new Map(); // id -> collected stream frames
    this.emptyFrames = 0; // daemon keepalive probe leaks "" frames (see note below)
    ws.on("message", (data) => {
      const text = data.toString();
      if (text.trim() === "" || text === '""') {
        // src/watch.rs uses `send("")` on a per-session queue as a liveness
        // probe; those empty strings are forwarded verbatim to the client.
        this.emptyFrames++;
        return;
      }
      const msg = JSON.parse(text);
      if (msg.ev === "fsevent") return;
      const id = msg.id;
      if (msg.ev && this.frames.has(id)) this.frames.get(id).push(msg);
      // Note: the daemon's WS `list` has no final {ok:true} frame — completion
      // is signalled by {ev:"done"}. Other methods do reply with {ok:true}.
      if (msg.err !== undefined || msg.ok || msg.ev === "done") {
        const slot = this.pending.get(id);
        if (slot) {
          this.pending.delete(id);
          slot.resolve({ frames: this.frames.get(id) || [], final: msg });
        }
      }
    });
  }

  call(method, params) {
    const id = String(++this.id);
    this.frames.set(id, []);
    const p = new Promise((resolve) => this.pending.set(id, { resolve }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Independent reference: decode the same entry with Python's zipfile. */
function referenceBytes(entry) {
  const code =
    "import sys,zipfile,hashlib;z=zipfile.ZipFile(sys.argv[1]);" +
    "d=z.read(sys.argv[2]);print(hashlib.sha256(d).hexdigest(), len(d))";
  return execFileSync("python3", ["-c", code, ZIP, entry], { encoding: "utf8" }).trim();
}

const asList = (frames) => {
  const rows = [];
  for (const f of frames) if (f.ev === "entries") rows.push(...f.entries);
  return rows;
};
const shape = (rows) => rows.map((r) => `${r.name}:${r.kind}:${r.size}`).sort();

async function main() {
  console.log(`\n\x1b[1mzip-vfs end-to-end test\x1b[0m  (${BIN})\n`);
  const { child, url } = await bootDaemon();
  const port = new URL(url).port;
  const cookie = await authenticate(url);
  console.log(`  daemon on 127.0.0.1:${port}, session cookie acquired`);

  const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`, {
    headers: { Cookie: cookie },
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const rpc = new Rpc(ws);

  console.log("\n\x1b[1m1. plugin registry\x1b[0m");
  const hello = await rpc.call("hello", {});
  const plugins = hello.final.result.plugins || [];
  const zip = plugins.find((p) => p.id === "zip-vfs");
  check("hello lists zip-vfs", !!zip, JSON.stringify(zip || plugins));
  check("capabilities are fs:read only", zip && JSON.stringify(zip.capabilities) === '["fs:read"]');
  check("hooks are list+read", zip && zip.hooks.join(",") === "list,read");
  check("matches *.zip", zip && zip.matches.join(",") === "*.zip");

  console.log("\n\x1b[1m2. list inside the archive (\x1b[0m/ws `list` → wasmtime → plugin\x1b[1m)\x1b[0m");
  const t0 = Date.now();
  const root = await rpc.call("list", { path: ARCHIVE });
  const rootMs = Date.now() - t0;
  const rootRows = asList(root.frames);
  check(
    "archive root shape",
    JSON.stringify(shape(rootRows)) ===
      JSON.stringify(["assets:1:0", "data:1:0", "readme.md:0:58", "src:1:0"]),
    JSON.stringify(shape(rootRows)) + ` in ${rootMs}ms`,
  );
  check("hostile entries not listed", !rootRows.some((r) => r.name.includes("evil") || r.name === "abs.txt"));
  check("done frame reports 4 entries", root.frames.some((f) => f.ev === "done" && f.n === 4));

  const src = asList((await rpc.call("list", { path: `${ARCHIVE}src` })).frames);
  check(
    "src/ shape (implied dir de-duplicated with explicit dir entry)",
    JSON.stringify(shape(src)) === JSON.stringify(["lib.rs:0:47", "main.rs:0:39", "util:1:0"]),
    JSON.stringify(shape(src)),
  );

  const util = asList((await rpc.call("list", { path: `${ARCHIVE}src/util` })).frames);
  check(
    "src/util/ shape",
    JSON.stringify(shape(util)) === JSON.stringify(["helper.rs:0:41", "mod.rs:0:16"]),
    JSON.stringify(shape(util)),
  );

  const assets = asList((await rpc.call("list", { path: `${ARCHIVE}assets` })).frames);
  check(
    "assets/ shape",
    JSON.stringify(shape(assets)) === JSON.stringify(["img:1:0", "logo.txt:0:9"]),
    JSON.stringify(shape(assets)),
  );

  const data = asList((await rpc.call("list", { path: `${ARCHIVE}data` })).frames);
  check(
    "data/ shape",
    JSON.stringify(shape(data)) ===
      JSON.stringify([
        "bigrandom.bin:0:204800",
        "blob.bin:0:8192",
        "empty.txt:0:0",
        "mixed.bin:0:88960",
        "pseudorandom.txt:0:65536",
        "repetitive.txt:0:202400",
        "stored.bin:0:8192",
      ]),
    JSON.stringify(shape(data)),
  );

  console.log("\n\x1b[1m3. read out of the archive (HTTP /api/file)\x1b[0m");
  const get = async (p) => {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/file?path=${encodeURIComponent(p)}`,
      { headers: { Cookie: cookie } },
    );
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };

  const md = await get(`${ARCHIVE}readme.md`);
  check("readme.md status 200", md.status === 200, `status ${md.status}`);
  check(
    "readme.md bytes match reference",
    sha256(md.body) === referenceBytes("readme.md").split(" ")[0],
    md.body.toString().trim().split("\n")[0],
  );

  // The 200 KB repetitive entry exercises dynamic-Huffman blocks and long
  // back-references; the plugin also verifies its crc32 internally.
  const rep = await get(`${ARCHIVE}data/repetitive.txt`);
  const [repHash, repLen] = referenceBytes("data/repetitive.txt").split(" ");
  check("repetitive.txt inflates to the exact reference bytes", sha256(rep.body) === repHash, `${rep.body.length} bytes`);
  check("repetitive.txt length matches reference", String(rep.body.length) === repLen);

  const rnd = await get(`${ARCHIVE}data/pseudorandom.txt`);
  const [rndHash] = referenceBytes("data/pseudorandom.txt").split(" ");
  check("pseudorandom.txt (literal-heavy deflate) matches reference", sha256(rnd.body) === rndHash);

  const stored = await get(`${ARCHIVE}data/stored.bin`);
  const [storedHash] = referenceBytes("data/stored.bin").split(" ");
  check("stored.bin (method 0, no inflation) matches reference", sha256(stored.body) === storedHash, `${stored.body.length} bytes`);

  const blob = await get(`${ARCHIVE}data/blob.bin`);
  check("blob.bin (stored *deflate* blocks) matches reference", sha256(blob.body) === referenceBytes("data/blob.bin").split(" ")[0]);

  const big = await get(`${ARCHIVE}data/bigrandom.bin`);
  check("bigrandom.bin (multiple stored blocks, 200 KB) matches reference", sha256(big.body) === referenceBytes("data/bigrandom.bin").split(" ")[0], `${big.body.length} bytes`);

  const mixed = await get(`${ARCHIVE}data/mixed.bin`);
  check("mixed.bin (dynamic + stored blocks) matches reference", sha256(mixed.body) === referenceBytes("data/mixed.bin").split(" ")[0], `${mixed.body.length} bytes`);

  const empty = await get(`${ARCHIVE}data/empty.txt`);
  check("empty.txt reads as zero bytes", empty.status === 200 && empty.body.length === 0, `status ${empty.status}, ${empty.body.length} bytes`);

  const nested = await get(`${ARCHIVE}src/util/helper.rs`);
  check("nested read src/util/helper.rs", nested.status === 200 && nested.body.toString().includes("fn help"), nested.body.toString().trim());

  console.log("\n\x1b[1m4. sandbox / hardening\x1b[0m");
  const evil = await get(`${ARCHIVE}../evil.txt`);
  check("../evil.txt is not readable through the plugin", evil.status >= 400, `status ${evil.status}`);
  const abs = await get(`${ARCHIVE}/abs.txt`);
  check("/abs.txt is not readable through the plugin", abs.status >= 400, `status ${abs.status}`);
  const missing = await get(`${ARCHIVE}src/nope.rs`);
  check("missing entry yields an error, not empty data", missing.status >= 400, `status ${missing.status}`);

  // An encrypted entry (encryption bit set in the general-purpose flags) must
  // fail with a clear message rather than inflating ciphertext.
  const encArchive = `${ZIP.replace(/kit\.zip$/, "kit-encrypted.zip")}!/`;
  const encList = asList((await rpc.call("list", { path: encArchive })).frames);
  check("encrypted archive lists its entry names", encList.some((r) => r.name === "secret.txt"), JSON.stringify(shape(encList)));
  const enc = await get(`${encArchive}secret.txt`);
  check("encrypted entry is refused", enc.status >= 400, `status ${enc.status}`);

  // An `archive!/inner` path must be routed *only* to a plugin that claims the
  // archive. With no matching plugin (or a missing archive) the daemon must
  // error rather than silently falling back to the real filesystem.
  const unclaimed = await rpc.call("list", { path: `${ROOT}/demo/not-an-archive.tar!/inner` });
  check(
    "unclaimed archive path errors instead of falling back to the filesystem",
    !!unclaimed.final.err || unclaimed.frames.some((f) => f.err),
    JSON.stringify(unclaimed.final.err || "no error frame"),
  );

  const realDir = await rpc.call("list", { path: `${ROOT}/plugins/zip-vfs` });
  check(
    "real directories still list without any plugin involvement",
    asList(realDir.frames).some((r) => r.name === "plugin.toml" && r.kind === 0),
    JSON.stringify(shape(asList(realDir.frames))),
  );

  console.log("\n\x1b[1m5. auth gate\x1b[0m");
  const noCookie = await fetch(`http://127.0.0.1:${port}/api/file?path=/etc/hostname`);
  check("no cookie → 401", noCookie.status === 401, `status ${noCookie.status}`);
  const badToken = await fetch(`http://127.0.0.1:${port}/auth?token=deadbeef`);
  check("wrong token → 401", badToken.status === 401, `status ${badToken.status}`);
  const noCookieWs = await new Promise((resolve) => {
    const w = new WebSocketImpl(`ws://127.0.0.1:${port}/ws`);
    w.on("unexpected-response", (_req, res) => resolve(res.statusCode));
    w.on("open", () => {
      w.close();
      resolve(200);
    });
    w.on("error", () => resolve(-1));
  });
  check("WebSocket without cookie is rejected", noCookieWs !== 200, `handshake status ${noCookieWs}`);

  ws.close();
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 150));

  if (rpc.emptyFrames > 0) {
    console.log(
      `\n\x1b[33mWARNING (daemon, not plugin):\x1b[0m received ${rpc.emptyFrames} empty WebSocket text frames. ` +
        `src/watch.rs uses \`session.send("")\` as a liveness probe on the per-connection queue, and ` +
        `src/ws.rs forwards every queued frame verbatim — a browser client doing JSON.parse() on each ` +
        `message will throw. Probe with a dedicated channel or send a real \`{"ev":"ping"}\` frame.`,
    );
  }

  console.log(`\n\x1b[1m${fail === 0 ? "\x1b[32mALL PASS" : "\x1b[31mFAILURES"}\x1b[0m  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n\x1b[31mtest harness error:\x1b[0m", e);
  process.exit(3);
});
