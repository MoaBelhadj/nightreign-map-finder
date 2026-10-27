// Capture worker: reads frames off the shared stream, keeps only the newest, and reports HUD readings.
// It runs off the page thread so it keeps full pace while the browser window is hidden behind the game.
importScripts("live-core.js");
const L = self.LiveCore, now = () => performance.timeOrigin + performance.now();
let regions = {}, interval = 1000 / 15, paused = false, want = null, lastAt = 0, lastFrame = 0, seq = 0;

onmessage = ({ data: m }) => {
  if (m.type === "start") run(m.readable);
  else if (m.type === "config") {
    if (m.regions) regions = m.regions;
    if (m.fps) interval = 1000 / m.fps;
    if ("paused" in m) paused = m.paused;
  } else want = m; // "find" or "snapshot", served from the next frame
};
setInterval(() => postMessage({ type: "beat", lastFrame }), 250); // lets the page notice a stalled capture even when no readings come

async function run(readable) {
  const reader = readable.getReader(), analyze = L.makeAnalyzer();
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;
      const t = lastFrame = now();
      try {
        if (want) { const m = want; want = null; await serve(frame, m); }
        if (paused || t - lastAt < interval) continue; // skip, never queue: the next frame is newer anyway
        lastAt = t;
        const W = frame.displayWidth, H = frame.displayHeight, r = analyze(frame, W, H, regions);
        postMessage({ type: "reading", seq: ++seq, tFrame: t, tDone: now(), w: W, h: H, ...r });
      } finally { frame.close(); }
    }
  } catch (e) { postMessage({ type: "error", message: String(e?.message || e) }); }
  postMessage({ type: "ended" });
}

async function serve(frame, m) {
  const W = frame.displayWidth, H = frame.displayHeight, s = Math.min(1, (m.maxW || 960) / W);
  const w = Math.round(W * s), h = Math.round(H * s), bitmap = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h });
  const out = { type: m.type, id: m.id, w, h, t: now(), bitmap };
  if (m.type === "find") out.regions = L.findBars(L.toImage(bitmap, w, h));
  postMessage(out, [bitmap]);
}
