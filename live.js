// Live companion: connects a capture source, turns HUD readings into short tips, and shows them in an overlay that can sit over the game.
// Uses the map finder's globals: state, sample, noClaude, render, WEAK, NIGHTFARERS, lordName, esc, GATED, shotJpeg.
(() => {
const L = LiveCore, $ = s => document.querySelector(s), now = () => performance.timeOrigin + performance.now();
const PHASES = ["Day 1", "Night 1", "Day 2", "Night 2", "Day 3: Nightlord"];
const TTL = { screen: 1500, shot: 30000 };
const BARS = [["hp", "hp", "HP"], ["fp", "fp", "FP"], ["sta", "sta", "Stamina"], ["boss", "bossHp", "Boss"]]; // [region, field, label]
const SRC = { screen: "live", shot: "screenshot", claude: "Claude", manual: "you", plan: "your plan" };
const SIZES = { s: [300, 160], m: [380, 210], l: [480, 260] };
const STATUS = { live: "Live", paused: "Paused", off: "Not connected", starting: "Starting", stale: "Reading lost", unsure: "Not sure", lost: "Capture lost" };

const load = (k, d) => { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || "{}") }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const S = load("nmf.live", { fps: 15, place: "dock", corner: "br", size: "m", opacity: 0.92, gap: 4, sound: "beep", volume: 0.6, mode: "auto", spoilers: true, depth: "quick", me: "" });
let regions = load("nmf.regions", {}); // HUD bar boxes, normalized to the frame

const store = L.makeStore(), feed = L.makeFeed(), trackers = {}, lat = [], e2e = [], readsAt = [], waiting = new Map();
const live = { kind: null, stream: null, worker: null, video: null, lastFrame: 0, lostReason: "", status: "off", reason: "",
  paused: false, muted: false, phase: 0, stop: 0, route: null, epoch: 0, dark: false, bossSeen: -1e9, bossOnAt: -1e9,
  prevBoss: false, lastHitAt: -1e9, hpHist: [], late: 0, expect: null };
let pip = null, sim = null, shot = null, rec = null, askCtl = null, actx = null, reqId = 0, latAt = 0;
const hud = $("#hud");

function note(text, err) { $("#lv-status").textContent = text; $("#lv-status").classList.toggle("err", !!err); }

// ---- Sources: screen or window share, capture card, simulated HUD. All end up as one video track.
async function connect(kind, deviceId) {
  stopCapture();
  live.lostReason = "";
  try { actx ??= new AudioContext(); } catch {} // created on this click so tip sounds can play later
  let stream;
  try {
    if (kind === "screen") {
      if (!navigator.mediaDevices?.getDisplayMedia) throw { name: "NotSupportedError" };
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
        audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include" });
    } else if (kind === "card") stream = await navigator.mediaDevices.getUserMedia({ video: deviceId ? { deviceId: { exact: deviceId } } : true, audio: false });
    else stream = simStream();
  } catch (e) { renderControls(); return note(captureError(e), true); }
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => lost("Capture stopped: sharing ended or the window closed."));
  Object.assign(live, { kind, stream, lastFrame: 0, hpHist: [] });
  for (const k in trackers) delete trackers[k];
  startPipeline(track);
  if (kind === "card") listCards(track.getSettings().deviceId);
  note(kind === "sim" ? "Simulated HUD running: a short fight on a loop." : "Connected. Reading your HUD…");
  renderControls();
  if (!regions.hp && !regions.sta) setTimeout(() => live.stream && findBars(true), 700); // first run: calibrate from an early frame
}

function captureError(e) {
  const msg = String(e?.message || "");
  if (e?.name === "NotSupportedError" || e?.name === "TypeError") return "This browser can't capture here. Use Edge or Chrome with the local copy.";
  if (e?.name === "NotAllowedError" && /policy|context/i.test(msg)) return "Screen capture is blocked inside this frame. Open the local copy for live capture; screenshots and questions still work here.";
  if (e?.name === "NotAllowedError") return "Sharing was cancelled or blocked. Press the button again and pick the game window.";
  if (e?.name === "NotFoundError") return "No capture device found.";
  if (e?.name === "NotReadableError") return "That device is busy in another app.";
  return "Couldn't start capture: " + (msg || e?.name || "unknown error");
}

function startPipeline(track) {
  if (typeof MediaStreamTrackProcessor === "function" && typeof Worker === "function") {
    try {
      const w = new Worker("live-worker.js"), { readable } = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 });
      w.onmessage = e => onWorker(e.data);
      w.onerror = e => { e.preventDefault(); if (live.worker === w) { w.terminate(); live.worker = null; startFallback(track); } };
      w.postMessage({ type: "start", readable }, [readable]);
      live.worker = w;
      config();
      return;
    } catch {}
  }
  startFallback(track);
}
const config = () => live.worker?.postMessage({ type: "config", regions, fps: S.fps, paused: live.paused });

// shortcut: the page-thread fallback can't tell a frozen capture from a still one, and slows to 1 fps when the tab is hidden; upgrade if a browser without MediaStreamTrackProcessor matters.
function startFallback(track) {
  const v = live.video = Object.assign(document.createElement("video"), { muted: true, playsInline: true, srcObject: new MediaStream([track]) });
  v.play().catch(() => {});
  const analyze = L.makeAnalyzer();
  let seq = 0;
  const loop = () => {
    if (live.video !== v) return;
    const t = now();
    if (v.readyState >= 2) live.lastFrame = t;
    if (v.readyState >= 2 && !live.paused) onReading({ seq: ++seq, tFrame: t, ...analyze(v, v.videoWidth, v.videoHeight, regions), tDone: now() });
    else tick();
    setTimeout(loop, 1000 / S.fps);
  };
  loop();
}

function onWorker(m) {
  if (m.type === "reading") return onReading(m);
  if (m.type === "beat") { live.lastFrame = Math.max(live.lastFrame, m.lastFrame); return tick(); }
  if (m.type === "ended") return lost("Capture ended.");
  if (m.type === "error") return lost("Capture failed: " + m.message);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
}

// One frame from the capture, scaled to 960 px wide; "find" also locates the HUD bars in it.
function grab(type, maxW = 960) {
  if (live.worker) return new Promise((res, rej) => {
    const id = ++reqId;
    waiting.set(id, res);
    live.worker.postMessage({ type, id, maxW });
    setTimeout(() => { if (waiting.delete(id)) rej(new Error("no frame")); }, 3000);
  });
  return scaled(live.video, type, maxW);
}
async function scaled(src, type, maxW = 960) {
  const W = src.videoWidth || src.width, H = src.videoHeight || src.height, s = Math.min(1, maxW / W), w = Math.round(W * s), h = Math.round(H * s);
  const bitmap = await createImageBitmap(src, { resizeWidth: w, resizeHeight: h });
  return { bitmap, w, h, regions: type === "find" ? L.findBars(L.toImage(bitmap, w, h)) : null };
}

function onReading(m) {
  const t = now(), prevHp = L.resolve(store, "hp", t);
  live.lastFrame = Math.max(live.lastFrame, m.tFrame);
  readsAt.push(t);
  while (readsAt[0] < t - 1000) readsAt.shift();
  // A new situation (loading screen over, menu or teleport cut, boss bar on or off) outdates whatever Claude is still looking at.
  // Camera motion alone doesn't count: in a fight the picture changes every frame.
  if (m.scene > 0.35 || (live.dark && m.lum >= 0.05)) live.epoch++;
  live.dark = m.lum < 0.05;
  for (const [k, field] of BARS) {
    const r = m.bars[k];
    if (!r) continue;
    const v = L.track(trackers[k] ??= L.makeTracker(regions[k]?.full), r);
    if (v.value != null) L.observe(store, field, "screen", v.value, v.conf, m.tFrame, TTL.screen);
  }
  if (regions.boss) { // the boss bar counts as gone only after 2.5 s without it, so a flicker doesn't end the fight
    const b = m.bars.boss;
    if (b && b.conf >= 0.6 && b.fill > 0.01) live.bossSeen = m.tFrame;
    const present = m.tFrame - live.bossSeen < 2500;
    L.observe(store, "boss", "screen", present, 0.85, m.tFrame, TTL.screen);
    if (present !== live.prevBoss) live.epoch++;
    if (present && !live.prevBoss) live.bossOnAt = m.tFrame;
    if (!present && live.prevBoss) { L.forget(store, "bossName", "manual"); L.forget(store, "bossName", "claude"); $("#lv-boss").value = ""; }
    live.prevBoss = present;
  }
  const hp = L.resolve(store, "hp", t);
  if (hp?.src === "screen" && hp.conf >= 0.6) {
    if (prevHp?.src === "screen" && hp.value < prevHp.value - 0.03) live.lastHitAt = t;
    live.hpHist.push([m.tFrame, hp.value]);
    while (m.tFrame - live.hpHist[0][0] > 1200) live.hpHist.shift();
    if (live.expect && !live.expect.seenAt && Math.abs(hp.value - live.expect.hp) < 0.12) live.expect.seenAt = t;
  }
  if (t - m.tDone > 150) { live.late++; return; } // waited in a busy page: skip drawing it, the next reading is newer
  tick(m);
}

function lost(reason) {
  if (!live.stream) return;
  stopCapture();
  live.lostReason = reason;
  L.dropSource(feed, "screen");
  tick();
  note(reason, true);
}
function stopCapture() {
  live.stream?.getTracks().forEach(t => t.stop());
  live.worker?.terminate();
  if (live.video) live.video.srcObject = null;
  if (sim) sim.alive = false;
  waiting.clear();
  Object.assign(live, { stream: null, worker: null, video: null, kind: null, lastFrame: 0, hpHist: [], dark: false });
  renderControls();
}

async function listCards(current) {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput"), sel = $("#lv-cards");
  sel.hidden = cams.length < 2;
  sel.innerHTML = cams.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === current ? " selected" : ""}>${esc(d.label || `Camera ${i + 1}`)}</option>`).join("");
}

// Simulated HUD: a canvas drawn like the game's bars, captured as a video stream, so the whole pipeline runs without the game.
function simStream() {
  const c = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 }), g = c.getContext("2d"), t0 = now();
  const s = sim = { hp: 1, fp: 0.8, sta: 1, boss: null, scene: 0, dark: false, hud: true, frozen: false, trail: 0, demo: !NMFLive.test, lastHp: 1, alive: true };
  const draw = () => {
    if (!s.alive) return;
    if (s.demo) demo(s, (now() - t0) / 1000);
    if (!s.frozen) {
      L.drawSim(g, c.width, c.height, s);
      if (s.hp !== s.lastHp) { s.lastHp = s.hp; markChange(s.hp, now()); }
    }
    requestAnimationFrame(draw);
  };
  draw();
  return c.captureStream(60);
}
function demo(s, t) {
  const p = t % 14;
  s.scene = Math.floor(t / 7);
  s.hp = p < 2 ? 1 : p < 4 ? 0.62 : p < 6 ? 0.22 : 1; // big hit, low HP, healed
  s.sta = p > 8 && p < 9.5 ? 0.05 : 0.9;
  s.boss = p > 7 && p < 13 ? Math.max(0.1, 1 - (p - 7) / 5.5) : null;
}
// End-to-end timing: the simulator and latency-test.html report when HP changed on screen; the next matching reading closes the sample.
function markChange(hp, t) { live.expect = { hp, t }; }
try { new BroadcastChannel("nmf-latency").onmessage = e => markChange(e.data.hp, e.data.t); } catch {}

// ---- State: what is reliable right now, and the context the tip rules read.
function liveState(t) {
  if (!live.stream) return live.lostReason ? { status: "lost", reason: live.lostReason } : { status: "off", reason: "No capture connected." };
  if (live.paused) return { status: "paused", reason: "Paused. Press P to resume." };
  if (!live.lastFrame) return { status: "starting", reason: "Waiting for the first frame…" };
  const age = t - live.lastFrame;
  if (age > 1000) return { status: "stale", reason: `No new frames for ${(age / 1000).toFixed(1)} s. Is the game window minimized?` };
  if (live.dark) return { status: "unsure", reason: "The screen is dark (loading or a cutscene)." };
  if (!regions.hp && !regions.sta) return { status: "unsure", reason: "HUD bars not calibrated yet. Press Find bars." };
  const seen = f => { const r = L.resolve(store, f, t); return r?.src === "screen" && r.conf >= 0.5; };
  if (!seen("hp") && !seen("sta")) return { status: "unsure", reason: "Can't see your HUD bars (menu, map or cutscene?)." };
  return { status: "live", reason: "" };
}

function context(t) {
  const r = f => L.resolve(store, f, t), hp = r("hp"), boss = r("boss");
  const peak = live.hpHist.reduce((a, [, v]) => Math.max(a, v), 0), drop = hp?.src === "screen" ? peak - hp.value : 0;
  const stops = state.route ? [...state.route.day1, ...state.route.day2] : [];
  const mode = S.mode !== "auto" ? S.mode : boss?.value || t - live.lastHitAt < 8000 ? "combat" : "explore";
  return { now: t, mode, spoilers: S.spoilers, me: S.me, weak: WEAK[state.lord], phase: live.phase, next: stops[live.stop] || null, stops,
    hp, fp: r("fp"), sta: r("sta"), boss, bossHp: r("bossHp"), bossName: r("bossName"),
    ev: { bigHit: drop >= 0.3 ? drop : 0, bossOn: t - live.bossOnAt < 1500 } };
}

function tick(m) {
  const t = now(), st = liveState(t);
  Object.assign(live, st);
  if (live.route !== state.route) { live.route = state.route; live.stop = 0; }
  if (st.status !== "live") L.dropSource(feed, "screen"); // never leave confident live advice up once the reading is unreliable
  const c = context(t);
  if (live.paused) feed.items = [];
  // Screenshot readings inform the panel and questions, never live tips: a "Heal now" from an old still would be wrong.
  const tips = live.paused ? [] : L.evaluate(c).filter(x => x.src !== "shot" && (st.status === "live" || x.src !== "screen"));
  const fresh = L.updateFeed(feed, tips, t, { minGap: S.gap * 1000 });
  draw(c, t, m);
  fresh.forEach(announce);
}

// ---- Output: overlay, readings, sound.
const secs = ms => `${(ms / 1000).toFixed(1)} s`;
const pctOf = f => `${Math.round(f.value * 100)}%`;
function tipFact(i, t) {
  const age = i.obsAt != null ? ` · ${secs(t - i.obsAt)} ago` : "";
  return esc(({ screen: "Seen: ", shot: "Screenshot: ", claude: "Claude saw: ", plan: "Plan: " }[i.src] || "") + i.fact) + age;
}
function draw(c, t, m) {
  const st = live.status;
  hud.dataset.status = st;
  hud.querySelector(".hud-state").textContent = STATUS[st];
  hud.querySelector(".hud-mode").textContent = `${c.mode === "combat" ? "Combat" : "Exploring"} · ${PHASES[live.phase]}${live.muted ? " · muted" : ""}`;
  hud.querySelector(".hud-meta").textContent = st === "live"
    ? `frame ${secs(t - live.lastFrame)} · ${readsAt.length} fps${lat.length ? ` · ${Math.round(L.quantile(lat.map(x => x.total), 0.5))} ms` : ""}`
    : live.reason + (["stale", "unsure", "lost"].includes(st) ? " Live advice paused." : "");
  hud.querySelector(".hud-read").innerHTML = BARS.map(([, f, label]) => {
    const v = c[f];
    if (f === "bossHp") return v && c.boss?.value ? `<span class="${v.conf < 0.6 ? "dim" : ""}">${label} ${pctOf(v)}</span>` : "";
    return v ? `<span class="${v.conf < 0.6 || v.conflict ? "dim" : ""}">${label} ${pctOf(v)}</span>` : `<span class="dim">${label} ?</span>`;
  }).join("");
  const items = feed.items.slice(0, 3);
  hud.querySelector(".hud-tips").innerHTML = items.length
    ? items.map(i => `<li class="tip ${i.level}"><b>${esc(i.text)}</b><small>${tipFact(i, t)}</small></li>`).join("")
    : `<li class="tip none"><small>${st === "live" ? "No tips right now." : "Nothing to show."}</small></li>`;

  $("#lv-readings").innerHTML = [...BARS.map(([, f, label]) => [label, c[f]]), ["Boss bar", c.boss], ["Boss name", c.bossName]].map(([label, v]) => {
    if (!v) return `<dt>${label}</dt><dd class="dim">unknown</dd>`;
    const val = typeof v.value === "number" ? pctOf(v) : typeof v.value === "boolean" ? (v.value ? "visible" : "not visible") : esc(v.value);
    return `<dt>${label}</dt><dd>${val} <span class="dim">· ${SRC[v.src]} · ${secs(v.age)} old · ${v.conf >= 0.6 ? "confident" : "unsure"}${v.conflict ? " · sources disagree" : ""}</span></dd>`;
  }).join("") + `<dt>Capture</dt><dd>${live.kind ? `${{ screen: "Screen share", card: "Capture card", sim: "Simulated HUD" }[live.kind]} · ${live.worker ? "worker thread" : "page thread"}` : "none"}</dd>`;
  $("#lv-route").textContent = c.stops.length ? `Route stop ${Math.min(live.stop + 1, c.stops.length)} of ${c.stops.length}` : "No route planned yet";

  if (m) { // latency sample: frame arrival to the overlay's next painted frame (or to the DOM update when nothing on screen paints it)
    const w = hud.ownerDocument.defaultView, sample = painted => {
      const tp = now();
      lat.push({ total: tp - m.tFrame, detect: m.tDone - m.tFrame, painted });
      if (lat.length > 300) lat.shift();
      if (live.expect?.seenAt) { e2e.push(tp - live.expect.t); if (e2e.length > 100) e2e.shift(); live.expect = null; }
    };
    if (w.document.visibilityState === "visible") w.requestAnimationFrame(() => sample(true)); else sample(false);
  }
  if (t - latAt > 500) { latAt = t; $("#lv-lat").textContent = latencyText(); }
}

function report() {
  const q = (a, p) => a.length ? Math.round(L.quantile(a, p)) : null, tot = lat.map(x => x.total);
  return { pipeline_ms: { samples: tot.length, painted: lat.filter(x => x.painted).length, p50: q(tot, 0.5), p95: q(tot, 0.95), max: tot.length ? Math.round(Math.max(...tot)) : null, detect_p50: q(lat.map(x => x.detect), 0.5) },
    screen_change_to_tip_ms: { samples: e2e.length, p50: q(e2e, 0.5), p95: q(e2e, 0.95), max: e2e.length ? Math.round(Math.max(...e2e)) : null },
    analysis_fps: readsAt.length, late_readings_skipped: live.late, thread: live.worker ? "worker" : live.video ? "page" : "none", source: live.kind, browser: navigator.userAgent };
}
function latencyText() {
  const r = report();
  if (!r.pipeline_ms.samples) return "Latency: no samples yet.";
  return `Latency, frame arrival to overlay painted: median ${r.pipeline_ms.p50} ms, 95% under ${r.pipeline_ms.p95} ms (${r.pipeline_ms.samples} frames, detection ${r.pipeline_ms.detect_p50} ms).`
    + (r.screen_change_to_tip_ms.samples ? ` Change on screen to overlay: median ${r.screen_change_to_tip_ms.p50} ms, 95% under ${r.screen_change_to_tip_ms.p95} ms (${r.screen_change_to_tip_ms.samples} changes).` : "");
}

function announce(tip) {
  if (live.muted || S.sound === "off" || tip.level === "info") return;
  if (S.sound === "voice" && "speechSynthesis" in window) {
    speechSynthesis.cancel();
    speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(tip.text), { rate: 1.25, volume: S.volume }));
    return;
  }
  try {
    const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime;
    o.frequency.value = tip.level === "urgent" ? 880 : 620;
    g.gain.setValueAtTime(S.volume * 0.3, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    o.connect(g).connect(actx.destination);
    o.start(t0); o.stop(t0 + 0.2);
  } catch {}
}

// ---- Overlay placement: docked, floating in the page, full screen (second monitor), or an always-on-top pop-out over the game.
let framed = true;
try { framed = window.top !== window; } catch {}
async function popOut() {
  if (pip) return pip.close();
  if (!window.documentPictureInPicture || framed) return note(framed ? "The pop-out can't open inside claude.ai's frame. Use the local copy for the over-game overlay, or full screen on your second monitor." : "The pop-out needs Edge or Chrome 116 or newer. Use full screen on your second monitor instead.", true);
  try { pip = await documentPictureInPicture.requestWindow({ width: SIZES[S.size][0], height: SIZES[S.size][1] }); }
  catch { return note("The pop-out window couldn't open. Use full screen on your second monitor instead.", true); }
  document.querySelectorAll("style, link[rel=stylesheet]").forEach(n => pip.document.head.append(n.cloneNode(true)));
  pip.document.body.className = "pip";
  pip.document.body.append(hud);
  pip.addEventListener("keydown", onKey);
  pip.addEventListener("pagehide", () => { $("#hud-home").append(hud); pip = null; apply(); });
  apply();
}

function apply() {
  hud.dataset.size = S.size;
  hud.style.setProperty("--hud-alpha", S.opacity);
  hud.classList.toggle("float", S.place === "float" && !pip);
  hud.dataset.corner = S.corner;
  $("#lv-fps-out").textContent = `${S.fps} per second`;
  $("#lv-opacity-out").textContent = `${Math.round(S.opacity * 100)}%`;
  $("#lv-gap-out").textContent = `${S.gap} s`;
  config();
  renderControls();
}
function renderControls() {
  const press = (id, on, yes, no) => { const b = $(id); b.setAttribute("aria-pressed", on); b.textContent = on ? yes : no; };
  press("#lv-pause", live.paused, "Resume", "Pause");
  press("#lv-mute", live.muted, "Unmute", "Mute");
  press("#lv-pop", !!pip, "Close pop-out", "Pop out over game");
  press("#lv-mic", !!rec, "Stop voice", "Voice");
  $("#lv-stop").hidden = !live.stream;
  $("#lv-mode").value = S.mode;
  $("#lv-phase").value = live.phase;
  $("#lv-spoilers").checked = S.spoilers;
  $("#lv-me").value = S.me;
}

// ---- Controls, shared by buttons, hotkeys and voice.
const setPaused = on => { live.paused = on; config(); renderControls(); tick(); };
const setMuted = on => { live.muted = on; if (on) window.speechSynthesis?.cancel(); renderControls(); tick(); };
const setS = (k, v) => { S[k] = v; save("nmf.live", S); renderControls(); tick(); };
const nextStop = d => { const n = context(now()).stops.length; if (n) live.stop = Math.max(0, Math.min(n - 1, live.stop + d)); tick(); };
const nextPhase = d => { live.phase = (live.phase + d + PHASES.length) % PHASES.length; renderControls(); tick(); };
function onKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const act = { p: () => setPaused(!live.paused), m: () => setMuted(!live.muted), 1: () => setS("mode", "auto"), 2: () => setS("mode", "combat"), 3: () => setS("mode", "explore"),
    n: () => nextStop(e.shiftKey ? -1 : 1), d: () => nextPhase(e.shiftKey ? -1 : 1), q: () => ask(""), v: toggleVoice, o: popOut, s: () => setS("spoilers", !S.spoilers) }[e.key.toLowerCase()];
  if (act) { e.preventDefault(); act(); }
}
addEventListener("keydown", onKey);

// Voice: commands run instantly on this page; anything else becomes a question.
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return note("Voice input isn't supported in this browser.", true);
  if (rec) { const r = rec; rec = null; r.stop(); return renderControls(); }
  const r = rec = new SR();
  let startedAt = 0;
  Object.assign(r, { continuous: true, interimResults: false, lang: navigator.language || "en-US" });
  r.onresult = e => voice(e.results[e.results.length - 1][0].transcript);
  r.onerror = e => { if (/not-allowed|service-not-allowed|audio-capture/.test(e.error)) { rec = null; renderControls(); note("The microphone is blocked or missing, so voice is off.", true); } };
  r.onend = () => { if (rec !== r) return; if (now() - startedAt > 1000) { startedAt = now(); r.start(); } else { rec = null; renderControls(); note("Voice stopped. Press Voice to listen again.", true); } }; // the browser ends listening after silence: restart, but not in a tight loop
  startedAt = now();
  r.start();
  renderControls();
  note("Listening. Say “next”, “mute”, “pause”, “combat”, “explore”, or ask a question.");
}
const COMMANDS = [[/^(next|skip)( stop)?$/, () => nextStop(1)], [/^(back|previous)( stop)?$/, () => nextStop(-1)], [/\bunmute\b|sound on/, () => setMuted(false)],
  [/\bmute\b|sound off|quiet/, () => setMuted(true)], [/^(pause|stop advice)$/, () => setPaused(true)], [/^(resume|start advice)$/, () => setPaused(false)],
  [/combat( mode)?$/, () => setS("mode", "combat")], [/explor/, () => setS("mode", "explore")], [/auto( mode)?$/, () => setS("mode", "auto")],
  [/(next|new) (day|night|phase)/, () => nextPhase(1)]];
function voice(text) {
  const t = text.toLowerCase().replace(/[.!?]/g, "").trim(), hit = COMMANDS.find(([re]) => re.test(t));
  if (hit) { hit[1](); note(`Heard “${text.trim()}”.`); } else ask(text);
}

// ---- Screenshots: read the HUD from a still image, and keep it for questions.
async function useShot(file) {
  if (!file?.type?.startsWith("image/")) return note("That file isn't an image. Use a PNG or JPEG screenshot.", true);
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return note("That image couldn't be read.", true); }
  shot?.bmp.close();
  shot = { bmp, t: now() };
  const f = await scaled(bmp, "find"), reg = regions.hp || regions.sta ? regions : f.regions; // a screenshot never overwrites your saved calibration
  preview(f.bitmap);
  const r = L.makeAnalyzer()(bmp, bmp.width, bmp.height, reg);
  let read = 0;
  for (const [k, field] of BARS) {
    const b = r.bars[k];
    if (b && b.conf >= 0.5) { L.observe(store, field, "shot", Math.min(1, b.fill / (reg[k]?.full || 1)), b.conf, shot.t, TTL.shot); read++; }
  }
  note(read ? "Screenshot read. Its readings count for 30 s; ask about it below." : "No HUD bars found in that screenshot. You can still ask about it below.");
  tick();
}
$("#lv-file").addEventListener("change", e => useShot(e.target.files[0]));
const drop = $("#lv-drop");
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); useShot(e.dataTransfer.files[0]); });
document.addEventListener("paste", e => {
  if (!document.activeElement?.closest?.("#live")) return; // the map finder takes pastes everywhere else
  const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (f) { e.preventDefault(); useShot(f); }
});

// ---- Calibration: find the bars automatically, or draw a box around one on the preview.
async function findBars(auto) {
  let f = null;
  try { f = live.stream ? await grab("find") : shot ? await scaled(shot.bmp, "find") : null; } catch {}
  if (!f) return note(auto ? "Couldn't get a frame to calibrate from yet. Press Find bars." : "Connect a capture or drop a screenshot first.", true);
  preview(f.bitmap);
  const got = Object.keys(f.regions);
  if (!got.length) return note(auto ? "Couldn't find your HUD bars yet. In game, with the HUD showing and full HP, press Find bars." : "No HUD bars found in this frame. Show the HUD at full HP and try again, or draw the boxes.", true);
  regions = { ...regions, ...f.regions };
  saveRegions();
  const names = { hp: "HP", fp: "FP", sta: "stamina", boss: "boss bar" };
  note(`Found ${got.map(k => names[k]).join(", ")}.${f.regions.boss ? "" : " No boss bar in this frame: press Find bars again during a boss fight, or draw it."} Check the boxes in the preview.`);
}
function saveRegions() { save("nmf.regions", regions); for (const k in trackers) delete trackers[k]; config(); preview(); }

const pv = $("#lv-preview"), pg = pv.getContext("2d");
let pvBmp = null, drag = null;
function preview(bmp) {
  if (bmp) { pvBmp?.close(); pvBmp = bmp; pv.width = bmp.width; pv.height = bmp.height; pv.hidden = false; }
  if (!pvBmp) return;
  pg.drawImage(pvBmp, 0, 0);
  const col = { hp: "#ee8a78", fp: "#9592f7", sta: "#7cc79a", boss: "#d6b45f" };
  pg.lineWidth = 2;
  for (const [k, r] of Object.entries(regions)) { pg.strokeStyle = col[k]; pg.strokeRect(r.x * pv.width, r.y * pv.height, r.w * pv.width, r.h * pv.height); }
  if (drag) { pg.strokeStyle = "#fff"; pg.setLineDash([4, 3]); pg.strokeRect(...drag.rect); pg.setLineDash([]); }
}
const at = e => { const b = pv.getBoundingClientRect(); return [(e.clientX - b.left) * pv.width / b.width, (e.clientY - b.top) * pv.height / b.height]; };
pv.addEventListener("pointerdown", e => { const [x, y] = at(e); drag = { x, y, rect: [x, y, 0, 0] }; pv.setPointerCapture(e.pointerId); });
pv.addEventListener("pointermove", e => {
  if (!drag) return;
  const [x, y] = at(e);
  drag.rect = [Math.min(drag.x, x), Math.min(drag.y, y), Math.abs(x - drag.x), Math.abs(y - drag.y)];
  preview();
});
pv.addEventListener("pointerup", () => {
  if (!drag) return;
  const [x, y, w, h] = drag.rect, k = $("#lv-bar").value;
  drag = null;
  if (w > 8 && h >= 1) { regions[k] = L.region(k, x / pv.width, y / pv.height, w / pv.width, h / pv.height); saveRegions(); note("Box saved. Draw it around the bar when it's full."); }
  else preview();
});

// ---- Questions: quick answers from this page first; Claude for the rest, newest question wins, outdated answers dropped.
function localAnswer(q, c) {
  const s = q.toLowerCase();
  if (/\bweak/.test(s) && (/nightlord/.test(s) || s.includes(lordName(state.lord).toLowerCase()))) {
    if (!S.spoilers) return "Spoilers are off. Turn them on to see weaknesses.";
    if (c.weak) return `${lordName(state.lord)} is weak to ${c.weak}, according to community guides.`;
  }
  if (/where (do|should) i go|next stop|what'?s next/.test(s) && c.next) return `Next on your route: ${c.next.name}${c.next.where ? ` (${c.next.where})` : ""}. ${c.next.why}`;
  if (/^(status|readings|my (hp|health))\??$/.test(s.trim())) return BARS.map(([, f, label]) => `${label} ${c[f] ? `${pctOf(c[f])} (${SRC[c[f].src]})` : "unknown"}`).join(", ") + ".";
  return null;
}
const reading = f => f ? `${pctOf(f)} (${SRC[f.src]}, ${f.conf >= 0.6 ? "confident" : "unsure"}, ${secs(f.age)} old)` : "unknown";
const coachPrompt = (q, c, img) => `You are a concise Elden Ring Nightreign coach. The player is mid-run and will read your answer at a glance.

Player's Nightfarer: ${c.me || "not set"}. Team: ${state.team.join(", ") || "not set"}. Nightlord: ${lordName(state.lord)}${c.weak && c.spoilers ? ` (community guides list it as weak to ${c.weak})` : ""}. Phase (set by the player): ${PHASES[c.phase]}. Mode: ${c.mode}.
HUD readings from a pixel detector, which can be wrong: HP ${reading(c.hp)}, FP ${reading(c.fp)}, stamina ${reading(c.sta)}, boss bar ${c.boss ? (c.boss.value ? `visible at ${reading(c.bossHp)}` : "not visible") : "not tracked"}.${c.next ? `\nNext stop on their route plan: ${c.next.name}${c.next.where ? ` (${c.next.where})` : ""}.` : ""}${c.spoilers ? "" : "\nSpoilers are OFF: don't name bosses or describe boss mechanics, lore or items the player hasn't seen."}
${img ? `The image is ${img}.` : "There is no image: answer from the readings and the question."}

Question: ${q}

Report as "seen" only what you can actually see in the image, and never guess numbers or names you can't read. Keep each advice line under 15 words, most urgent first.
Reply with only JSON: {"seen": ["<fact visible in the image, under 10 words>"], "boss": "<boss name exactly as shown on screen, or empty>", "advice": ["<up to 3 short actions>"], "answer": "<one or two sentences answering the question>"}`;

async function ask(question) {
  const q = String(question || "").trim() || "What should I do right now?", t0 = now(), c = context(t0), quick = localAnswer(q, c);
  if (quick) return answer({ q, text: quick, meta: "Quick answer from this page" });
  if (!sample) return answer({ q, text: "Claude isn't available in this copy of the page, so only quick answers work here: the Nightlord's weakness, your next stop, and your readings. Open the claude.ai version to ask anything.", meta: "" });
  askCtl?.abort(); // the newest question wins
  const ctl = askCtl = new AbortController(), epoch = live.epoch;
  answer({ q, pending: true });
  let image = null, what = "";
  try {
    if (live.status === "live") { image = await shotJpeg((await grab("snapshot", 1600)).bitmap); what = "the player's live game frame, captured just now"; }
    else if (shot && t0 - shot.t < 600000) { image = await shotJpeg(shot.bmp); what = `a screenshot the player gave ${secs(t0 - shot.t)} ago`; }
  } catch {}
  try {
    const a = await sample.json(coachPrompt(q, c, what), { modelTier: S.depth, signal: ctl.signal, cache: false, ...(image && { images: [image] }) });
    const t1 = now(), arr = v => (Array.isArray(v) ? v : []).map(String).filter(Boolean);
    const outdated = what.startsWith("the player's live") && (live.epoch !== epoch || t1 - t0 > 10000);
    const res = { q, text: String(a?.answer || ""), advice: arr(a?.advice).slice(0, 3), seen: arr(a?.seen).slice(0, 4), outdated,
      meta: `Claude · ${secs(t1 - t0)} · ${image ? "with image" : "no image"}` };
    if (!outdated) {
      if (a?.boss && S.spoilers) L.observe(store, "bossName", "claude", String(a.boss).slice(0, 60), 0.7, t0, 120000);
      if (res.advice[0]) L.updateFeed(feed, [{ key: `claude:${t0}`, level: "info", hold: 8000, cooldown: 0, src: "claude", obsAt: t0, text: res.advice[0], fact: res.seen[0] || "your question" }], now(), { minGap: 0 });
    }
    answer(res);
    tick();
  } catch (e) {
    if (e?.code === "cancelled") return;
    if (GATED.includes(e?.code)) { sample = null; noClaude = true; render(); }
    answer({ q, error: askError(e) });
  } finally { if (askCtl === ctl) askCtl = null; }
}
function askError(e) {
  if (e?.code === "rate_limited") return "Claude is busy or you've hit a usage limit. Wait a bit, then ask again.";
  if (e?.code === "session_expired") return "Your Claude session expired. Sign in again, then ask.";
  if (e?.code === "image_rejected") return "The frame couldn't be sent to Claude. Ask again.";
  if (["invalid_json", "empty_completion", "refused"].includes(e?.code)) return "Claude's answer didn't come back in a usable form. Ask again, maybe more simply.";
  if (GATED.includes(e?.code)) return "Claude isn't available on this page.";
  return "Couldn't reach Claude. Try again.";
}
function answer(r) {
  const el = $("#lv-answer");
  if (r.pending) { el.innerHTML = `<p class="q">${esc(r.q)}</p><p class="dim">Thinking…</p>`; return; }
  el.innerHTML = `<p class="q">${esc(r.q)}</p>`
    + (r.error ? `<p class="err">${esc(r.error)}</p>` : "")
    + (r.outdated ? `<p class="warn">The game changed while Claude was thinking, so this answer was dropped from the overlay. Ask again for the current moment.</p>` : "")
    + (r.text ? `<p class="${r.outdated ? "dim" : ""}">${esc(r.text)}</p>` : "")
    + (r.advice?.length ? `<p class="eyebrow">Advice</p><ul class="${r.outdated ? "dim" : ""}">${r.advice.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "")
    + (r.seen?.length ? `<p class="eyebrow">What Claude could see</p><ul class="dim">${r.seen.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "")
    + (r.meta ? `<p class="fine">${esc(r.meta)}</p>` : "");
}

// ---- Wiring.
$("#lv-me").innerHTML = `<option value="">Not set</option>` + NIGHTFARERS.map(n => `<option>${n}</option>`).join("");
$("#lv-phase").innerHTML = PHASES.map((p, i) => `<option value="${i}">${p}</option>`).join("");
document.querySelectorAll("#live [data-set]").forEach(el => {
  const k = el.dataset.set;
  if (el.type === "checkbox") el.checked = !!S[k]; else el.value = S[k];
  el.addEventListener("input", () => { S[k] = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value; save("nmf.live", S); apply(); tick(); });
});
const on = (id, fn) => $(id).addEventListener("click", fn);
on("#lv-screen", () => connect("screen"));
on("#lv-card", () => connect("card"));
$("#lv-cards").addEventListener("change", e => connect("card", e.target.value));
on("#lv-sim", () => connect("sim"));
on("#lv-stop", () => { stopCapture(); tick(); note("Capture stopped."); });
on("#lv-pause", () => setPaused(!live.paused));
on("#lv-mute", () => setMuted(!live.muted));
on("#lv-pop", popOut);
on("#lv-full", () => pip ? note("Close the pop-out first.", true) : !hud.requestFullscreen ? note("Full screen isn't supported here.", true) : hud.requestFullscreen().catch(() => note("Full screen isn't allowed here.", true)));
on("#lv-next", () => nextStop(1));
on("#lv-prev", () => nextStop(-1));
$("#lv-phase").addEventListener("change", e => { live.phase = +e.target.value; tick(); });
on("#lv-find", () => findBars(false));
on("#lv-snap", async () => { try { preview((live.stream ? await grab("snapshot") : await scaled(shot.bmp)).bitmap); } catch { note("Connect a capture or drop a screenshot first.", true); } });
on("#lv-clear", () => { regions = {}; saveRegions(); note("Calibration cleared."); });
on("#lv-mic", toggleVoice);
on("#lv-now", () => ask(""));
on("#lv-copy", () => navigator.clipboard?.writeText(JSON.stringify(report(), null, 2)).then(() => note("Latency report copied."), () => note("Couldn't copy here.", true)));
$("#lv-ask").addEventListener("submit", e => { e.preventDefault(); ask($("#lv-q").value); $("#lv-q").value = ""; });
document.querySelectorAll("#live [data-ignore]").forEach(el => el.addEventListener("change", () => { L.block(store, el.dataset.ignore, "screen", el.checked); tick(); }));
$("#lv-boss").addEventListener("change", e => { const v = e.target.value.trim(); if (v) L.observe(store, "bossName", "manual", v, 1, now(), Infinity); else L.forget(store, "bossName", "manual"); tick(); });

const policy = document.permissionsPolicy || document.featurePolicy;
if (policy?.allowsFeature && !policy.allowsFeature("display-capture")) {
  $("#lv-screen").disabled = true;
  note("Screen capture is blocked inside this frame. Open the local copy for live capture (see Setup below). Screenshots and questions still work here.");
}
setInterval(tick, 500); // keeps ages and status current when no capture is sending readings
apply();
tick();

window.NMFLive = { live, store, feed, lat, e2e, S, test: false, get sim() { return sim; }, get regions() { return regions; },
  connect, stopCapture, findBars, ask, useShot, setPaused, setMuted, nextPhase, report, voice };
})();
