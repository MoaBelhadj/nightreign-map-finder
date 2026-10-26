// Drives headless Edge over the DevTools protocol: loads the test page, waits for the harness to finish, saves the log and a screenshot.
// Usage: node cdp-test.mjs <devtools port> <url> <out dir> [viewport width]
import { writeFileSync } from "node:fs";
const [port, url, outDir, width = "1280"] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === "page"); } catch {}
  if (!target) await sleep(200);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;

await send("Emulation.setDeviceMetricsOverride", { width: +width, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url });
let log = "";
for (let i = 0; i < 60; i++) {
  await sleep(500);
  log = await evaluate(`document.getElementById("calls")?.textContent || ""`) || "";
  if (/find done|driver:|error:|rejection:/.test(log)) break;
}
writeFileSync(`${outDir}/log.txt`, log);
const h = await evaluate(`document.documentElement.scrollHeight`);
await send("Emulation.setDeviceMetricsOverride", { width: +width, height: Math.min(h, 6000), deviceScaleFactor: 1, mobile: false });
await sleep(800);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(`${outDir}/shot.png`, Buffer.from(shot.result.data, "base64"));
console.log("done; log chars", log.length, "page height", h);
ws.close();
