// Renders the README screenshots into docs/media/: starts vite on a free port,
// opens dev/shots.html?state=<state> (and settings.html?demo=1) in headless
// Microsoft Edge or Google Chrome, and stops vite again. No extra npm packages
// (Node 22+ for the built-in WebSocket).
//
//   npm run screenshots

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "media");
const MAX_BYTES = 400 * 1024;

// [name, page, width, height]. The island windows are 800 wide like the real panel;
// a height of 0 fits the page's full height (the settings window scrolls).
const SHOTS = [
  ["strip", "dev/shots.html?state=strip", 520, 56],
  ["compact", "dev/shots.html?state=compact", 620, 96],
  ["expanded", "dev/shots.html?state=expanded", 800, 400],
  ["approval", "dev/shots.html?state=approval", 800, 260],
  ["question", "dev/shots.html?state=question", 800, 440],
  ["reply", "dev/shots.html?state=reply", 800, 260],
  ["plan", "dev/shots.html?state=plan", 800, 340],
  ["finished", "dev/shots.html?state=finished", 800, 190],
  ["finished-merged", "dev/shots.html?state=finished-merged", 800, 190],
  ["settings", "settings.html?demo=1", 600, 0],
];

function browser() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
          "C:/Program Files/Google/Chrome/Application/chrome.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`No Edge or Chrome found. Looked in:\n  ${candidates.join("\n  ")}`);
  return found;
}

function freePort() {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function startVite(port) {
  const bin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [bin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((ok, fail) => {
    let log = "";
    const timer = setTimeout(() => fail(new Error(`vite did not start:\n${log}`)), 30_000);
    const onData = (d) => {
      // Drop the colour codes so the "Local: http://127.0.0.1:<port>" line can be matched.
      log += String(d).replace(/\u001b\[[0-9;]*m/g, "");
      if (log.includes(`127.0.0.1:${port}`)) {
        clearTimeout(timer);
        ok(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => fail(new Error(`vite exited with ${code}:\n${log}`)));
  });
}

// One headless browser for all shots, driven over the DevTools protocol: each page
// is captured once it sets document.body.dataset.ready (a plain --screenshot fires
// before the springs and fades have settled).
async function launch(exe) {
  // A fresh profile: no cache, no restored state, nothing shared with the user's browser.
  const profile = mkdtempSync(join(tmpdir(), "sb-shots-"));
  const child = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--hide-scrollbars",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
    if (Date.now() > deadline) throw new Error("The browser did not open its DevTools port");
    await sleep(100);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("No page target in the headless browser");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = () => fail(new Error("Could not connect to the DevTools page"));
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.fail(new Error(msg.error.message));
    else w.ok(msg.result);
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      id += 1;
      waiting.set(id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const close = async () => {
    ws.close();
    child.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  return { send, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(cdp, url, out, w, h, scale) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  // Clear the previous page's flag so the wait below cannot see it.
  await cdp.send("Runtime.evaluate", { expression: "document.body && delete document.body.dataset.ready" });
  await cdp.send("Page.navigate", { url });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const r = await cdp.send("Runtime.evaluate", { expression: "document.body?.dataset.ready === '1'", returnByValue: true });
    if (r.result.value === true) break;
    if (Date.now() > deadline) throw new Error(`${url} never set data-ready`);
    await sleep(100);
  }
  if (h === 0) {
    const r = await cdp.send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: w, height: r.result.value, deviceScaleFactor: scale, mobile: false });
    await sleep(200);
  }
  const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
}

async function main() {
  const exe = browser();
  mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  const vite = await startVite(port);
  const cdp = await launch(exe);
  try {
    // Warm up: the first request makes vite pre-bundle and transform everything.
    await fetch(`http://127.0.0.1:${port}/dev/shots.ts`).catch(() => {});
    for (const [name, page, w, h] of SHOTS) {
      const out = join(OUT, `${name}.png`);
      const url = `http://127.0.0.1:${port}/${page}`;
      await shoot(cdp, url, out, w, h, 2);
      if (statSync(out).size > MAX_BYTES) await shoot(cdp, url, out, w, h, 1);
      const size = statSync(out).size;
      if (size === 0) throw new Error(`${name}.png is empty`);
      console.log(`${name}.png  ${w}x${h || "fit"}  ${Math.round(size / 1024)} KB`);
    }
  } finally {
    await cdp.close();
    vite.kill();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
