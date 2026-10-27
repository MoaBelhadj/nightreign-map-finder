// End-to-end run in headless Edge: the real page, worker and MediaStreamTrackProcessor, fed by the simulated HUD and by real tab capture.
// Claude is a stand-in (build/mock.html plus a coach mock below). Usage: node test/e2e.mjs [screenshot.png]
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EDGE = process.env.EDGE || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const PORT = 8799, DBG = 9339, base = `http://127.0.0.1:${PORT}`, shotPath = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn("py", ["serve.py", String(PORT)], { cwd: root, stdio: "ignore" });
const edge = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${DBG}`, `--user-data-dir=${join(process.env.E2E_PROFILE || tmpdir(), "nmf-e2e-profile")}`,
  "--no-first-run", "--autoplay-policy=no-user-gesture-required", "--auto-select-tab-capture-source-by-title=Latency test", "about:blank"], { stdio: "ignore" });
const cleanup = () => { for (const p of [edge, server]) try { execSync(`taskkill /pid ${p.pid} /T /F`, { stdio: "ignore" }); } catch {} };

async function open(url) {
  let t;
  for (let i = 0; i < 50 && !t; i++) { try { t = await (await fetch(`http://127.0.0.1:${DBG}/json/new?${url}`, { method: "PUT" })).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(t.webSocketDebuggerUrl), pending = new Map(), listeners = [];
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  ws.addEventListener("message", e => { const m = JSON.parse(e.data); if (m.method) listeners.forEach(f => f(m)); pending.get(m.id)?.(m); pending.delete(m.id); });
  const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression, userGesture = false) => {
    const m = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture });
    if (m.result?.exceptionDetails) throw new Error(JSON.stringify(m.result.exceptionDetails).slice(0, 800));
    return m.result?.result?.value;
  };
  return { id: t.id, send, evaluate, on: f => listeners.push(f) };
}

const oldMock = readFileSync(join(root, "build/mock.html"), "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];
const coachMock = `(() => {
  const old = window.claude.use;
  window.__mock = { delay: 300, reply: null, calls: [], aborted: 0 };
  const coach = (input, opts) => new Promise((res, rej) => {
    if (opts.signal?.aborted) { __mock.aborted++; return rej({ code: "cancelled" }); }
    __mock.calls.push({ q: (input.match(/Question: (.*)/) || [])[1], images: [].concat(opts.images || []).length, tier: opts.modelTier });
    const t = setTimeout(() => res(__mock.reply || { seen: ["HP bar about a fifth full"], boss: "", advice: ["Back off and heal"], answer: "Heal first, then re-engage." }), __mock.delay);
    opts.signal?.addEventListener("abort", () => { clearTimeout(t); __mock.aborted++; rej({ code: "cancelled" }); });
  });
  window.claude = { use: async n => {
    const m = await old(n);
    return n !== "sample" ? m : Object.assign(async () => ({ text: "" }), { limits: m.limits, json: (input, opts = {}) => /concise Elden Ring Nightreign coach/.test(input) ? coach(input, opts) : m.json(input, opts) });
  } };
})();`;

try {
  const page = await open("about:blank");
  await page.send("Page.enable");
  await page.send("Network.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true }); // the profile is reused between runs; always test the files on disk
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: oldMock + "\n" + coachMock });
  const errors = [];
  page.on(m => {
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(m.params.args.map(a => a.value ?? a.description).join(" "));
  });
  await page.send("Runtime.enable");
  await page.send("Page.navigate", { url: `${base}/nightreign-map-finder.html` });
  await sleep(2000);
  await page.evaluate(readFileSync(join(root, "test/e2e-driver.js"), "utf8"));
  const out = { framed: await page.evaluate("__framed()") };
  if (process.env.ONLY_FRAMED) { console.log(JSON.stringify(out, null, 2)); cleanup(); process.exit(0); }
  out.regress = await page.evaluate("__regress()");
  out.live = await page.evaluate("__e2e()");
  out.pip = await page.evaluate("__pip()", true).catch(e => ({ error: String(e) }));
  // The latency page gets its own window so both pages keep painting; then the main window is minimized, as it would be behind the game.
  const browser = await (async () => {
    const ws = new WebSocket((await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json()).webSocketDebuggerUrl), pending = new Map();
    await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    ws.addEventListener("message", e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
    return (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  })();
  await browser("Target.createTarget", { url: `${base}/latency-test.html`, newWindow: true });
  await sleep(1500);
  out.capture = { visible: await page.evaluate("__capture(8000)", true).catch(e => ({ error: String(e) })) };
  const { windowId } = (await browser("Browser.getWindowForTarget", { targetId: page.id })).result;
  await browser("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  await sleep(500);
  out.capture.minimized = await page.evaluate("__capture(8000)").catch(e => ({ error: String(e) }));
  await browser("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await page.evaluate("NMFLive.stopCapture()");
  if (shotPath) { // the overlay mid-demo, for a visual check
    await page.evaluate(`NMFLive.test = false; NMFLive.connect("sim"); document.getElementById("live").scrollIntoView(); new Promise(r => setTimeout(r, 5200))`, true);
    writeFileSync(shotPath, Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 1400, deviceScaleFactor: 1, mobile: true });
    await page.evaluate(`document.getElementById("live").scrollIntoView(); new Promise(r => setTimeout(r, 600))`);
    writeFileSync(shotPath.replace(/\.png$/, "-phone.png"), Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
    out.phoneOverflow = await page.evaluate("document.documentElement.scrollWidth > innerWidth");
  }
  out.consoleErrors = errors;
  console.log(JSON.stringify(out, null, 2));
  const f = out.framed;
  process.exitCode = out.live.failed || !(f.shareDisabled && f.help && f.mentionsCmd && f.link) ? 1 : 0;
} finally { cleanup(); }
