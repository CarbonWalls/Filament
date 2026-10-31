/**
 * Documentation screenshots.
 *
 *   node scripts/shots.mjs [--url <auth url>]
 *
 * Boots its own daemon (unless --url is given) and drives the *real* app into
 * the scenarios the README talks about. Every image in docs/ comes from here,
 * so the docs cannot drift away from the product.
 */
import { chromium, devices } from "../web/node_modules/playwright/index.mjs";
import { mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const out = resolve(process.cwd(), "docs");
const demo = process.env.FILAMENT_DEMO ?? resolve(process.cwd(), "demo");
mkdirSync(out, { recursive: true });

const argUrl = process.argv.find((a) => a.startsWith("--url="))?.slice(6);
let child;
let url = argUrl;
if (!url) {
  const bin = resolve(process.cwd(), "target/release/filament");
  child = spawn(bin, ["--port", "8124", "--allow-debug"], { stdio: ["ignore", "pipe", "pipe"] });
  url = await new Promise((res) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:\d+\/auth\?token=[a-f0-9]+/);
      if (m) res(m[0]);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ["--no-sandbox", "--font-render-hinting=none"] });

async function session(opts) {
  const ctx = await browser.newContext({ colorScheme: "dark", ...opts });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[err]", e.message.slice(0, 160)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".pane .rows-wrap", { timeout: 15000 });
  await sleep(700);
  return { ctx, page };
}

const nav = async (page, path, ms = 450) => {
  await page.evaluate((p) => window.__filament.workspace.panes()[0].navigate(p), path);
  await sleep(ms);
};
const select = async (page, name) => {
  await page.evaluate((n) => {
    const w = window.__filament.workspace;
    const pane = w.panes()[0];
    const entry = pane.entries().find((e) => e.name === n);
    if (entry) pane.setSelection([`${pane.path()}/${entry.name}`]);
  }, name);
  await sleep(450);
};
const shot = async (page, name) => {
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("wrote", name);
};

// ------------------------------------------------------------------ desktop --
{
  const { page, ctx } = await session({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

  // Hero: a split with a bound preview rendering real Rust.
  await nav(page, `${demo}/projects/alpha/src`);
  await page.evaluate(() => window.__filament.split("h", "preview"));
  await sleep(500);
  await select(page, "main.rs");
  await page.evaluate(() => window.__filament.workspace.focus(window.__filament.workspace.panes()[0].id));
  await sleep(600);
  await shot(page, "00-hero");

  // List view: notes, sorted by modified.
  await page.evaluate(() => {
    const w = window.__filament.workspace;
    w.close(w.panes()[1].id);
  });
  await nav(page, `${demo}/notes`, 600);
  await page.evaluate(() => window.__filament.workspace.panes()[0].setSort({ key: "mtime", dir: -1 }));
  await sleep(400);
  await shot(page, "01-list");

  // Grid over the generated photos, so thumbnails are visible.
  await page.evaluate(() => window.__filament.workspace.panes()[0].setView("grid"));
  await nav(page, `${demo}/photos`, 2600);
  await shot(page, "02-grid");

  // Inside a zip, served by the WASM backend plugin.
  await page.evaluate(() => window.__filament.workspace.panes()[0].setView("list"));
  await nav(page, `${demo}/kit.zip!/src`, 900);
  await shot(page, "03-zip-vfs");

  // Command palette with a query typed.
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".palette", { timeout: 5000 });
  await page.keyboard.type("split");
  await sleep(400);
  await shot(page, "04-palette");
  await page.keyboard.press("Escape");
  await sleep(200);

  // Search pane (streamed from the daemon walker).
  await nav(page, `${demo}`, 400);
  await page.evaluate(() => window.__filament.split("v", "search"));
  await sleep(500);
  await page.keyboard.type("schema");
  await sleep(1200);
  await shot(page, "05-search");
  await page.evaluate(() => {
    const w = window.__filament.workspace;
    w.close(w.panes()[1].id);
  });
  await sleep(300);

  // Skeleton + shimmer: cold folder with the daemon in debug slow-motion.
  await page.evaluate(() => window.__filament.setSlow(420));
  await nav(page, `${demo}/projects/beta/src`, 140);
  await shot(page, "06-skeleton");
  await page.evaluate(() => window.__filament.setSlow(0));
  await sleep(900);

  // Latency HUD. Prime it the way a *person* would, so the panel shows real
  // numbers rather than the empty state a scripted session leaves behind:
  // dwell on a folder (120 ms hover prefetch), open it, then let idle prefetch
  // and the back/forward LRU absorb the burst.
  const openFolder = async (name) => {
    const row = page.locator(".rows-wrap .row", { hasText: name }).first();
    await row.hover();
    await sleep(320); // past the 120 ms dwell timer, so the scan has landed
    await row.dblclick();
    await sleep(500);
  };
  await nav(page, `${demo}`, 500);
  await openFolder("notes");
  await nav(page, `${demo}`, 500);
  await openFolder("projects");
  await openFolder("beta");
  await page.evaluate(() => window.__filament.workspace.goBack(window.__filament.workspace.focusedId()));
  await sleep(300);
  await page.evaluate(() => window.__filament.workspace.goBack(window.__filament.workspace.focusedId()));
  await sleep(300);
  // Then the *common* case: wandering around a tree you already know. Every one
  // of these revisits is served from the LRU, which is what the 80% target is
  // actually about — a first pass through new folders is cold by definition.
  for (let i = 0; i < 2; i++) {
    await openFolder("notes");
    await nav(page, `${demo}`, 400);
    await openFolder("projects");
    await nav(page, `${demo}`, 400);
  }
  await openFolder("notes");

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".statusbar button")].pop();
    btn?.click();
  });
  await sleep(600);
  await shot(page, "07-latency-hud");
  await page.keyboard.press("Control+Shift+d"); // toggle it back off
  await sleep(300);

  // Light theme.
  await page.evaluate(() => window.__filament.theme("paper-ink"));
  await nav(page, `${demo}/notes`, 600);
  await select(page, "2026-09-08-1on1-notes.txt");
  await shot(page, "08-light");

  await ctx.close();
}

// ------------------------------------------------------------------- mobile --
{
  const { page, ctx } = await session({ ...devices["iPhone 13"], deviceScaleFactor: 3 });
  await nav(page, `${demo}/photos`, 400);
  await page.evaluate(() => window.__filament.workspace.panes()[0].setView("grid"));
  await nav(page, `${demo}/photos`, 2600);
  await shot(page, "09-mobile-grid");
  await page.evaluate(() => window.__filament.workspace.panes()[0].setView("list"));
  await nav(page, `${demo}`, 800);
  await page.evaluate(() => window.__filament.split("h", "list"));
  await sleep(700);
  await shot(page, "10-mobile-split");
  await ctx.close();
}

await browser.close();
child?.kill("SIGTERM");
console.log("done");
