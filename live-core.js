// Live companion core: HUD bar reading, scene changes, source resolution and tip rules.
// Pure functions shared by the page (live.js), the capture worker (live-worker.js) and the Node tests (test/live-core.test.js).
(function (root) {
"use strict";

// Bar colours as hue windows in degrees. The empty track is dark and the damage trail is yellow, so neither counts as filled.
const SPECS = {
  hp: { hue: 358, tol: 20, minS: 0.45, minV: 0.22 },
  fp: { hue: 222, tol: 28, minS: 0.4, minV: 0.25 },
  sta: { hue: 122, tol: 30, minS: 0.35, minV: 0.22 },
  boss: { hue: 358, tol: 20, minS: 0.45, minV: 0.18 },
};

function match(d, i, s) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  const max = Math.max(r, g, b), c = max - Math.min(r, g, b);
  if (!c || max < s.minV * 255 || c < s.minS * max) return false;
  let h = 60 * (max === r ? (g - b) / c : max === g ? (b - r) / c + 2 : (r - g) / c + 4);
  if (h < 0) h += 360;
  const dh = Math.abs(h - s.hue) % 360;
  return (dh > 180 ? 360 - dh : dh) <= s.tol;
}

// img: {data: RGBA bytes, width, height} of one bar's box. Returns how far the bar is filled from the left, and how bar-like the pixels look.
function readBar(img, spec) {
  const { data, width: w, height: h } = img, gap = Math.max(2, Math.round(w * 0.03)), on = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (match(data, (y * w + x) * 4, spec)) n++;
    on[x] = n * 2 >= h ? 1 : 0;
  }
  const start = on.indexOf(1);
  if (start < 0) return { fill: 0, conf: 0.2 }; // an empty bar and a hidden HUD look the same
  let end = start, run = 0;
  for (let x = start; x < w && x - end <= gap; x++) if (on[x]) { end = x; run++; }
  let stray = 0;
  for (let x = end + gap + 1; x < w; x++) stray += on[x];
  const density = run / (end - start + 1), lead = start <= w * 0.06 ? 1 : 0.35;
  return { fill: (end + 1) / w, conf: Math.max(0, Math.min(1, density * lead * (1 - (stray / w) * 6))) };
}

// img holds three equal bands: just above the bar, through it, just below. Colour that runs past the bar's edges is scenery
// (lava behind the boss bar, a red sky), not a bar.
function readBox(img, spec) {
  const { data, width: w, height: h } = img, band = h / 3, row = w * 4;
  const r = readBar({ data: data.subarray(band * row, 2 * band * row), width: w, height: band }, spec);
  const end = Math.round(r.fill * w);
  let hit = 0;
  for (const y of [0, h - 1]) for (let x = 0; x < end; x++) if (match(data, (y * w + x) * 4, spec)) hit++;
  return end && hit > end ? { fill: r.fill, conf: r.conf * 0.2 } : r; // more than half of the 2 * end edge pixels match
}

const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];
const quantile = (a, q) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : null;

// Turns raw fill into a 0-1 value. `full` is the fill seen at full health; it grows when the bar lengthens on level-up.
function makeTracker(full) { return { full: full || 1, grow: 0, hist: [] }; }
function track(t, r) {
  if (r.conf < 0.5) return { value: t.hist.length ? median(t.hist) : null, conf: r.conf };
  if (r.conf >= 0.7 && r.fill > t.full * 1.02) { if (++t.grow >= 3) { t.full = r.fill; t.grow = 0; } } else t.grow = 0;
  const v = Math.min(1, r.fill / t.full);
  t.hist.push(v);
  if (t.hist.length > 3) t.hist.shift();
  return { value: r.conf >= 0.8 ? v : median(t.hist), conf: r.conf }; // a clean bar is trusted at once; only doubtful frames wait for the median
}

function luma(img) {
  const { data, width, height } = img, n = width * height, px = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += px[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) / 255;
  return { px, mean: sum / n };
}
function sceneDiff(a, b) {
  if (!a || !b) return 0;
  let d = 0;
  for (let i = 0; i < a.px.length; i++) d += Math.abs(a.px[i] - b.px[i]);
  return d / a.px.length;
}

// Calibration: finds each bar as the longest thin horizontal run of its colour inside the part of the screen where it lives.
const ZONES = { hp: [0, 0, 0.5, 0.25], fp: [0, 0, 0.5, 0.25], sta: [0, 0, 0.5, 0.25], boss: [0.1, 0.62, 0.9, 0.97] };
const GROW = 1.35; // player bars lengthen as you level, so their read box extends past the bar found at calibration
function region(k, x, y, w, h) {
  const cy = y + h / 2, ch = Math.max(h * 0.6, 0.002); // read the middle of the bar, away from its frame
  if (k === "boss") return { x, y: cy - ch / 2, w, h: ch, full: 1 };
  const w2 = Math.min(w * GROW, 0.6 - x);
  return { x, y: cy - ch / 2, w: w2, h: ch, full: w / w2 };
}
function findBars(img, specs = SPECS) {
  const { data, width: W, height: H } = img, out = {};
  for (const k of Object.keys(ZONES)) {
    const [zx0, zy0, zx1, zy1] = ZONES[k], x0 = Math.floor(zx0 * W), x1 = Math.floor(zx1 * W);
    const minLen = (k === "boss" ? 0.15 : 0.05) * W, bands = [];
    let cur = null;
    for (let y = Math.floor(zy0 * H); y < Math.floor(zy1 * H); y++) {
      let s = -1, last = -9, bs = 0, be = -1;
      for (let x = x0; x < x1; x++) {
        if (!match(data, (y * W + x) * 4, specs[k])) continue;
        if (x - last > 3) s = x;
        last = x;
        if (x - s > be - bs) { bs = s; be = x; }
      }
      if (be - bs + 1 < minLen) { cur = null; continue; }
      if (cur && y === cur.y1 + 1 && Math.abs(bs - cur.s) <= 0.01 * W) { cur.y1 = y; cur.e = Math.max(cur.e, be); }
      else bands.push(cur = { s: bs, e: be, y0: y, y1: y });
    }
    const bars = bands.filter(b => b.y1 > b.y0 && b.y1 - b.y0 + 1 <= 0.035 * H); // thin and at least 2 rows: a bar, not scenery
    bars.sort((a, b) => (b.e - b.s) - (a.e - a.s) || a.y0 - b.y0); // the player's own bar is the longest; teammates' are shorter
    const b = bars[0];
    if (b) out[k] = region(k, b.s / W, b.y0 / H, (b.e - b.s + 1) / W, (b.y1 - b.y0 + 1) / H);
  }
  // The player's bars come as a set: HP on top, stamina below, starting at the same x. A lone line is a menu or scenery.
  const below = r => r && out.hp && Math.abs(r.x - out.hp.x) < 0.03 && r.y > out.hp.y;
  if (!below(out.sta)) { delete out.hp; delete out.fp; delete out.sta; }
  else if (!below(out.fp)) delete out.fp;
  return out;
}
// Canvas glue (browser and worker only; the Node tests use the pure functions above).
function ctx2d(w, h) { return new OffscreenCanvas(w, h).getContext("2d", { willReadFrequently: true }); }
function toImage(src, w, h) { const g = ctx2d(w, h); g.drawImage(src, 0, 0, w, h); return g.getImageData(0, 0, w, h); }
// Every crop goes into one small GPU canvas, read back once per frame: reading the whole frame back for each crop cost ~25 ms.
function makeAnalyzer() {
  const RW = 160, RH = 9, TW = 32, TH = 18, KEYS = ["hp", "fp", "sta", "boss"], TY = RH * KEYS.length, AH = TY + TH;
  const g = new OffscreenCanvas(RW, AH).getContext("2d", { willReadFrequently: false }); // false: keep it on the GPU
  let prev = null;
  return (src, W, H, regions, specs = SPECS) => {
    g.clearRect(0, 0, RW, AH);
    KEYS.forEach((k, i) => {
      const r = regions[k];
      if (r) g.drawImage(src, r.x * W, (r.y - r.h) * H, Math.max(1, r.w * W), Math.max(1, 3 * r.h * H), 0, i * RH, RW, RH); // the box plus a band above and below
    });
    g.drawImage(src, 0, 0, W, H, 0, TY, TW, TH);
    const all = g.getImageData(0, 0, RW, AH).data, bars = {}, row = RW * 4;
    KEYS.forEach((k, i) => {
      if (regions[k] && specs[k]) bars[k] = readBox({ data: all.subarray(i * RH * row, (i + 1) * RH * row), width: RW, height: RH }, specs[k]);
    });
    const th = new Uint8ClampedArray(TW * TH * 4);
    for (let y = 0; y < TH; y++) th.set(all.subarray((TY + y) * row, (TY + y) * row + TW * 4), y * TW * 4);
    const cur = luma({ data: th, width: TW, height: TH }), scene = sceneDiff(prev, cur);
    prev = cur;
    return { bars, scene, lum: cur.mean };
  };
}

// Observations from every input, per field. The winner is the most confident fresh one; the player's own corrections outrank everything.
const WEIGHT = { manual: 3, screen: 1, shot: 0.9, claude: 0.8 };
function makeStore() { return { obs: {}, blocked: {} }; }
function observe(st, field, src, value, conf, t, ttl) { (st.obs[field] ??= {})[src] = { value, conf, t, ttl }; }
function forget(st, field, src) { if (st.obs[field]) delete st.obs[field][src]; }
function block(st, field, src, on) { (st.blocked[field] ??= {})[src] = !!on; }
function resolve(st, field, now) {
  const c = [];
  for (const [src, o] of Object.entries(st.obs[field] || {})) {
    if (st.blocked[field]?.[src] || o.value == null) continue;
    const age = now - o.t, fresh = o.ttl === Infinity ? 1 : 1 - age / o.ttl;
    if (fresh <= 0) continue;
    c.push({ value: o.value, conf: o.conf * fresh, src, age, score: o.conf * fresh * (WEIGHT[src] ?? 1) });
  }
  if (!c.length) return null;
  c.sort((a, b) => b.score - a.score);
  const [best, next] = c;
  const differ = next && (typeof best.value === "number" ? Math.abs(best.value - next.value) > 0.15 : best.value !== next.value);
  // Only readings of the same moment can contradict each other; an older one that differs just means things changed.
  // A screenshot always shows an earlier moment, whenever it was dropped in.
  const conflict = !!(differ && best.src !== "manual" && best.src !== "shot" && next.src !== "shot"
    && next.score >= best.score * 0.8 && Math.abs(best.age - next.age) < 2000);
  return { value: best.value, conf: conflict ? best.conf * 0.5 : best.conf, src: best.src, age: best.age, conflict };
}

// Tip rules. Each returns the advice plus the observed fact behind it, so the overlay can keep the two apart.
const CASTERS = ["Recluse", "Revenant", "Duchess"];
const ok = f => !!f && f.conf >= 0.6;
const pc = v => Math.round(v * 100) + "%";
const bossTip = c => c.spoilers && c.phase === 4 && c.weak ? `Nightlord fight: weak to ${c.weak}. Use your ${c.weak} weapon`
  : c.spoilers && c.bossName?.value ? `${c.bossName.value}: dodge first, punish after its combos`
  : "Boss fight: dodge first, punish after its combos";
const RULES = [
  { id: "heal", level: "urgent", hold: 800, cooldown: 1500, // short: a combo that drops you again right after a heal must warn again
    when: c => ok(c.hp) && c.hp.value <= 0.3 && { text: "Heal now", fact: `HP ${pc(c.hp.value)}`, f: c.hp } },
  { id: "big-hit", level: "warn", hold: 3000, cooldown: 8000,
    when: c => c.ev.bigHit && ok(c.hp) && c.hp.value > 0.3 && { text: "Big hit. Back off and reset", fact: `Lost ${pc(c.ev.bigHit)} HP in a second`, f: c.hp } },
  { id: "stamina", level: "warn", modes: ["combat"], hold: 600, cooldown: 6000,
    when: c => ok(c.sta) && c.sta.value <= 0.12 && { text: "Out of stamina. Stop attacking, let it refill", fact: `Stamina ${pc(c.sta.value)}`, f: c.sta } },
  { id: "fp", level: "info", hold: 1500, cooldown: 20000,
    when: c => CASTERS.includes(c.me) && ok(c.fp) && c.fp.value <= 0.15 && { text: "Low FP. Drink an FP flask or switch to your weapon", fact: `FP ${pc(c.fp.value)}`, f: c.fp } },
  { id: "boss-on", level: "info", modes: ["combat"], hold: 6000, cooldown: 30000,
    when: c => c.ev.bossOn && { text: bossTip(c), fact: "Boss health bar appeared", f: c.boss } },
  { id: "boss-low", level: "info", modes: ["combat"], hold: 3000, cooldown: 30000,
    when: c => c.boss?.value && ok(c.bossHp) && c.bossHp.value <= 0.2 && { text: "Boss under 20%. Stay patient, don't trade hits", fact: `Boss ${pc(c.bossHp.value)}`, f: c.bossHp } },
  { id: "next-stop", level: "info", modes: ["explore"], plan: true, hold: 8000, cooldown: 60000, key: c => c.next?.name,
    when: c => c.next && { text: `Next: ${c.next.name}${c.next.where ? ` (${c.next.where})` : ""}`, fact: c.next.why || "From your route plan" } },
];
function evaluate(c) {
  const out = [];
  for (const r of RULES) {
    if (r.modes && !r.modes.includes(c.mode)) continue;
    const hit = r.when(c);
    if (!hit) continue;
    out.push({ key: r.key ? `${r.id}:${r.key(c)}` : r.id, id: r.id, level: r.level, hold: r.hold, cooldown: r.cooldown,
      src: hit.f?.src || (r.plan ? "plan" : "rule"), obsAt: hit.f ? c.now - hit.f.age : null, text: hit.text, fact: hit.fact });
  }
  return out;
}

// What the overlay shows. A tip stays while its condition holds, leaves `hold` ms after, and can't come back within `cooldown`.
const LEVELS = { urgent: 0, warn: 1, info: 2 };
function makeFeed() { return { items: [], ended: {}, lastAt: -Infinity }; }
function updateFeed(feed, tips, now, { minGap = 4000 } = {}) {
  const fresh = [];
  for (const tip of tips) {
    const cur = feed.items.find(i => i.key === tip.key);
    if (cur) { Object.assign(cur, tip, { t: cur.t, seen: now }); continue; }
    if (now - (feed.ended[tip.key] ?? -Infinity) < tip.cooldown) continue; // shown recently: don't repeat it
    if (tip.level !== "urgent" && now - feed.lastAt < minGap) continue; // frequency cap; urgent tips skip it
    const item = { ...tip, t: now, seen: now };
    feed.items.push(item);
    fresh.push(item);
    if (tip.level !== "urgent") feed.lastAt = now;
  }
  feed.items = feed.items.filter(i => {
    if (now - i.seen <= i.hold) return true;
    feed.ended[i.key] = now;
    return false;
  });
  feed.items.sort((a, b) => LEVELS[a.level] - LEVELS[b.level] || b.t - a.t);
  return fresh; // newly shown tips: the page sounds these
}
// Pulls tips built on a source that stopped being reliable. No cooldown, so they return as soon as the reading does.
function dropSource(feed, src) { feed.items = feed.items.filter(i => i.src !== src); }

// Simulated game frame for the demo, the latency test page and the end-to-end tests: Nightreign-style bars over moving scenery.
function drawSim(g, W, H, s) {
  const hue = (s.scene * 47) % 360;
  g.fillStyle = s.dark ? "#020203" : `hsl(${hue} 22% ${18 + (s.scene * 23) % 45}%)`;
  g.fillRect(0, 0, W, H);
  if (s.dark) return;
  for (let i = 0; i < 12; i++) {
    g.fillStyle = `hsl(${(hue + i * 30) % 360} 35% ${18 + (i * 7) % 30}%)`;
    g.fillRect(((i * 0.137 + s.scene * 0.05) % 1) * W, (0.3 + (i * 0.071) % 0.55) * H, W * 0.12, H * 0.1);
  }
  if (s.hud === false) return;
  const bar = (x, y, len, fill, th, color) => {
    g.fillStyle = "#151313"; g.fillRect(x * W, y * H, len * W, th * H);
    g.fillStyle = color; g.fillRect(x * W, y * H, len * fill * W, th * H);
  };
  const hpLen = 0.22 * (s.hpLen ?? 1);
  bar(0.06, 0.045, hpLen, s.hp, 0.009, "#a51d1a");
  if (s.trail) { g.fillStyle = "#d9a82e"; g.fillRect((0.06 + hpLen * s.hp) * W, 0.045 * H, hpLen * s.trail * W, 0.009 * H); }
  bar(0.06, 0.062, 0.16, s.fp, 0.009, "#2f52b8");
  bar(0.06, 0.079, 0.18, s.sta, 0.009, "#3d8f40");
  for (let i = 0; i < 2; i++) bar(0.03, 0.16 + i * 0.04, 0.08, 0.7, 0.006, "#a51d1a"); // teammates
  if (s.boss != null) {
    g.fillStyle = "#eee"; g.font = `${Math.round(H * 0.022)}px serif`;
    g.fillText(s.bossName || "Night Boss", 0.25 * W, 0.845 * H);
    bar(0.25, 0.86, 0.5, s.boss, 0.008, "#8f1a15");
  }
}

const LiveCore = { SPECS, readBar, readBox, makeTracker, track, luma, sceneDiff, findBars, region, toImage, makeAnalyzer,
  makeStore, observe, forget, block, resolve, RULES, evaluate, makeFeed, updateFeed, dropSource, quantile, drawSim };
if (typeof module === "object" && module.exports) module.exports = LiveCore;
else root.LiveCore = LiveCore;
})(typeof self !== "undefined" ? self : this);
