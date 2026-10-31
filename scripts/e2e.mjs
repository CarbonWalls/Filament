/**
 * Filament end-to-end check + screenshot harness.
 *
 *   node scripts/e2e.mjs [--url http://127.0.0.1:PORT/auth?token=…]
 *
 * With no --url it builds/starts nothing: point it at a running daemon. The
 * script asserts the things the design claims and prints a table, then writes
 * its (diagnostic) screenshots to target/e2e-shots/ — deliberately *not* docs/,
 * which holds the curated gallery that README.md references by name.
 */
import { chromium } from "../web/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";


const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith("--url="))?.slice(6) ?? args[args.indexOf("--url") + 1];
const demoRoot = process.env.FILAMENT_DEMO ?? resolve(process.cwd(), "demo");
const outDir = resolve(process.cwd(), "target/e2e-shots");
mkdirSync(outDir, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
});
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console error]", m.text());
});
page.on("pageerror", (e) => console.log("  [page error]", e.message));

// Boot our own daemon unless one was handed to us. `--slow` + `--allow-debug`
// let the loading states be photographed on a local disk; both are debug-only
// and off by default in normal use.
let child;
let auth = urlArg;
if (!auth) {
  const bin = resolve(process.cwd(), "target/release/filament");
  child = spawn(bin, ["--port", "8123", "--allow-debug"], { stdio: ["ignore", "pipe", "pipe"] });
  const line = await new Promise((res) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?token=[a-f0-9]+/);
      if (m) res(m[0]);
    });
  });
  auth = line;
}
await page.goto(auth, { waitUntil: "domcontentloaded" });

// ------------------------------------------------------------------ boot ---
await page.waitForSelector(".pane .rows-inner", { timeout: 15000 });
await page.waitForFunction(() => window.__filament !== undefined, { timeout: 10000 });
check("shell mounts and lists a folder", true);

const firstPaint = await page.evaluate(() => {
  const nav = performance.getEntriesByType("navigation")[0];
  return nav ? Math.round(nav.domContentLoadedEventEnd) : -1;
});
check("DOMContentLoaded under 400ms", firstPaint > 0 && firstPaint < 400, `${firstPaint}ms`);

// -------------------------------------------------------------- navigate ---
await page.evaluate((root) => window.__filament.nav(root), demoRoot);
await page.waitForFunction(() => document.querySelectorAll(".row").length > 0, { timeout: 15000 });
const rows = await page.locator(".row").count();
check("rows render for the demo root", rows > 0, `${rows} rows in DOM`);

// cold navigation latency
await page.evaluate(() => window.__filament.metrics.reset());
const many = `${demoRoot}/many`;
await page.evaluate((p) => window.__filament.nav(p), many);
await page.waitForFunction(() => document.querySelectorAll(".row").length > 10, { timeout: 20000 });
await page.waitForFunction(
  () => window.__filament.workspace.focused().phase() === "done",
  { timeout: 20000 }
);
const virtualised = await page.evaluate(() => ({
  dom: document.querySelectorAll(".row").length,
  status: document.querySelector(".statusbar")?.textContent ?? "",
  total: window.__filament.workspace.focused().entries().length,
}));
check(
  "2000-file folder is virtualized",
  virtualised.dom < 200 && virtualised.total >= 2000,
  `${virtualised.dom} DOM rows for ${virtualised.total} entries`
);

// -------------------------------------------------------------- prefetch ---
await page.evaluate(() => window.__filament.metrics.reset());
const fwd = [];
for (let i = 0; i < 12; i++) {
  // wander in and out: every "in" should be a cache hit after the first pass
  await page.evaluate((p) => window.__filament.nav(p), `${demoRoot}/projects`);
  await page.evaluate((p) => window.__filament.nav(p), `${demoRoot}/notes`);
  fwd.push(i);
}
await sleep(600);
const snapshot = await page.evaluate(() => window.__filament.metrics.snapshot());
// Steady-state numbers, captured before any debug slow-motion is applied.
const steady = snapshot;
check(
  "prefetch hit rate > 80%",
  (snapshot["prefetch.hitRate"] ?? 0) > 0.8,
  `${Math.round((snapshot["prefetch.hitRate"] ?? 0) * 100)}% over ${snapshot["nav.count"]} navigations`
);
check(
  "time-to-first-row p50 under 50ms",
  (snapshot["list.ttfb.p50"] ?? 999) < 50,
  `${(snapshot["list.ttfb.p50"] ?? 0).toFixed(1)}ms p50`
);

// ----------------------------------------------------------------- split ---
await page.evaluate((p) => window.__filament.nav(p), demoRoot);
await sleep(200);
await page.evaluate(() => window.__filament.split("h", "preview"));
await sleep(400);
const paneCount = await page.locator(".pane").count();
check("split creates a second pane", paneCount === 2, `${paneCount} panes`);
const dividerRatio = await page.evaluate(() => {
  const split = document.querySelector(".split");
  return split ? getComputedStyle(split).getPropertyValue("--ratio").trim() : "";
});
check("layout tree keeps a ratio per split", dividerRatio !== "", `--ratio: ${dividerRatio}`);

// drag the divider
const divider = page.locator(".divider").first();
const box = await divider.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await sleep(200);
}
const ratioAfter = await page.evaluate(() =>
  getComputedStyle(document.querySelector(".split")).getPropertyValue("--ratio").trim()
);
check("divider drag updates the ratio", ratioAfter !== dividerRatio, `${dividerRatio} → ${ratioAfter}`);

// select a file so the preview pane resolves its binding
await page.evaluate((root) => {
  const pane = window.__filament.workspace.panes()[0];
  pane.navigate(root);
}, `${demoRoot}/notes`);
await sleep(300);
await page.evaluate(() => {
  const pane = window.__filament.workspace.panes()[0];
  const entry = pane.entries().find((e) => e.kind === 0);
  if (entry) pane.setSelection([`${pane.path()}/${entry.name}`]);
});
await sleep(500);
const previewText = await page.locator(".preview-title").first().textContent();
check("preview pane follows the other pane's selection", !!previewText && previewText !== "Nothing selected", `“${previewText}”`);

await page.screenshot({ path: `${outDir}/01-split-desktop.png` });

// --------------------------------------------------------------- palette ---
await page.keyboard.press("Control+k");
await page.waitForSelector(".palette", { timeout: 5000 });
const paletteItems = await page.locator(".palette-item").count();
check("command palette opens from a plugin-registered keybinding", paletteItems > 5, `${paletteItems} items`);
await page.screenshot({ path: `${outDir}/02-palette.png` });
await page.keyboard.press("Escape");

// ------------------------------------------------------------ grid view ---
await page.evaluate(() => {
  const pane = window.__filament.workspace.panes()[0];
  pane.setView("grid");
});
await page.evaluate((p) => window.__filament.workspace.panes()[0].navigate(p), `${demoRoot}/photos`);
await sleep(900);
const cells = await page.locator(".cell").count();
check("grid view plugin renders thumbnail cells", cells > 0, `${cells} cells`);
await page.screenshot({ path: `${outDir}/03-grid.png` });

// ---------------------------------------------------------------- search ---
await page.evaluate((p) => window.__filament.workspace.panes()[0].navigate(p), demoRoot);
await sleep(300);
const search = await page.evaluate(async (root) => {
  const res = await fetch(`/api/preview?path=${encodeURIComponent(root + "/readme.md")}`);
  return res.ok ? await res.json() : null;
}, demoRoot);
check("preview endpoint returns file head bytes", !!search?.isText, search ? `${search.mime}, ${search.size} bytes` : "no response");

// -------------------------------------------------------------- skeleton ---
// A cold folder while the daemon is in debug slow-motion: this is exactly what
// a slow disk looks like, and it is the only state that shows a skeleton.
// Wait for the daemon's ack before trusting the state — otherwise a listing can
// finish before the delay is armed and the skeleton never gets a chance to
// mount (which is how this check once flaked).
const slowAck = await page.evaluate(() => window.__filament.setSlow(380));
check("daemon arms debug slow-motion (requires --allow-debug)", slowAck?.slowMs === 380, `ack ${JSON.stringify(slowAck)}`);
await sleep(120);
await page.evaluate(() => {
  const w = window.__filament.workspace;
  w.panes()[0].setView("list");
  w.panes()[1]?.setSelection([]);
});
const cold = `${demoRoot}/projects/beta/src`;
await page.evaluate(async (p) => {
  const w = window.__filament.workspace;
  w.panes()[0].navigate(p);
}, cold);
// Sample over the whole slow window rather than at one instant: under load the
// skeleton may mount a frame or two later than a fixed sleep assumes.
let shimmering = { skeleton: 0, shimmer: 0, progress: 0 };
for (let i = 0; i < 8; i++) {
  const s = await page.evaluate(() => ({
    skeleton: document.querySelectorAll(".skeleton-row").length,
    shimmer: document.querySelectorAll(".skeleton-live").length,
    progress: document.querySelectorAll(".progress-line").length,
  }));
  if (s.skeleton > shimmering.skeleton) shimmering = s;
  if (s.shimmer > shimmering.shimmer) shimmering = s;
  // Wait for the animated tier too (shimmer appears once the wait passes 200 ms).
  if (s.skeleton > 0 && s.shimmer > 0) break;
  await sleep(40);
}
await page.screenshot({ path: `${outDir}/04-skeleton.png` });
check(
  "cold folder shows a streaming skeleton (daemon in debug slow-motion)",
  shimmering.skeleton > 0,
  `${shimmering.skeleton} skeleton rows, shimmer=${shimmering.shimmer}, progress=${shimmering.progress}`
);
await sleep(900);
check("skeleton gives way to rows", (await page.locator(".skeleton-row").count()) === 0);
await page.evaluate(() => window.__filament.setSlow(0));

// ----------------------------------------------------------- latency HUD ---
// The HUD is the app's own claim-checking surface, so it had better not be a
// boot-time snapshot: read a counter, navigate, and read it again.
await page.keyboard.press("Control+Shift+d");
await page.waitForSelector(".perf-hud", { timeout: 5000 });
const hudValue = (label) =>
  page.evaluate((l) => {
    const row = [...document.querySelectorAll(".perf-hud .perf-row")].find((r) => r.textContent.includes(l));
    return Number(row?.querySelector("b")?.textContent ?? NaN);
  }, label);
const navsBefore = await hudValue("navigations");
await page.evaluate((p) => window.__filament.nav(p), `${demoRoot}/projects`);
await page.evaluate((p) => window.__filament.nav(p), `${demoRoot}/notes`);
await sleep(1300); // the HUD refreshes on a 1 s timer
const navsAfter = await hudValue("navigations");
check(
  "latency HUD reports live numbers rather than a mount-time snapshot",
  Number.isFinite(navsBefore) && navsAfter > navsBefore,
  `${navsBefore} → ${navsAfter} navigations`
);
await page.keyboard.press("Control+Shift+d");
await sleep(200);

// --------------------------------------------------------------- themes ---
await page.evaluate(() => window.__filament.theme("paper-ink"));
await page.evaluate((p) => window.__filament.nav(p), `${demoRoot}/projects`);
await sleep(500);
await page.screenshot({ path: `${outDir}/05-light.png` });
const themeAttr = await page.evaluate(() => document.documentElement.dataset.theme);
check("theme switch is a plugin", themeAttr === "paper-ink", themeAttr);
await page.evaluate(() => window.__filament.theme("ember"));
await sleep(300);

// ---------------------------------------------------------------- mobile ---
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const mpage = await mobile.newPage();
await mpage.goto(auth, { waitUntil: "domcontentloaded" });
await mpage.waitForSelector(".pane", { timeout: 15000 });
await mpage.evaluate((p) => window.__filament.nav(p), demoRoot);
await mpage.waitForTimeout(700);
const tabsVisible = await mpage.evaluate(() => {
  const el = document.querySelector(".pane-tabs");
  if (!el) return false;
  return getComputedStyle(el).display !== "none";
});
check("mobile keeps the same tree (pane tabs only when split)", tabsVisible === false, `tabs visible: ${tabsVisible}`);
const touchTargets = await mpage.evaluate(() => {
  const btn = document.querySelector(".icon-btn");
  if (!btn) return 0;
  const r = btn.getBoundingClientRect();
  return Math.round(Math.min(r.width, r.height));
});
check("coarse pointer targets are ≥44px", touchTargets >= 44, `${touchTargets}px`);
await mpage.screenshot({ path: `${outDir}/06-mobile.png` });

// --------------------------------------------------------------- summary ---
await page.screenshot({ path: `${outDir}/00-desktop.png` });
const failed = results.filter((r) => !r.ok);
console.log("\n── summary ─────────────────────────────────────────────");
for (const r of results) console.log(`${r.ok ? " ✓" : " ✗"} ${r.name}${r.detail ? `  (${r.detail})` : ""}`);
console.log("\n── steady-state metrics (before debug slow-motion) ─────");
for (const [k, v] of Object.entries(steady).sort()) {
  console.log(`  ${k.padEnd(24)} ${typeof v === "number" ? (v.toFixed?.(2) ?? v) : v}`);
}
await browser.close();
child?.kill("SIGTERM");
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);

async function demoRootPath(page) {
  return await page.evaluate(() => window.__filament.workspace.focused().path());
}
