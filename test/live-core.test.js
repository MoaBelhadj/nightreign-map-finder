// Unit tests for live-core.js. Run: node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../live-core.js");

// A tiny rasterizer: background colour plus filled rects in normalized coordinates.
function image(W, H, bg, rects = []) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) data.set([...bg, 255], i * 4);
  for (const [x, y, w, h, rgb] of rects)
    for (let py = Math.round(y * H); py < Math.round((y + h) * H); py++)
      for (let px = Math.round(x * W); px < Math.round((x + w) * W); px++) data.set([...rgb, 255], (py * W + px) * 4);
  return { data, width: W, height: H };
}
const RED = [165, 29, 26], TRACK = [21, 19, 19], YELLOW = [217, 168, 46], BLUE = [47, 82, 184], GREEN = [61, 143, 64], BOSS = [143, 26, 21];
const bar = (fill, extra = []) => image(160, 5, TRACK, [[0, 0, fill, 1, RED], ...extra]);

test("reads a partly filled bar", () => {
  const r = L.readBar(bar(0.6), L.SPECS.hp);
  assert.ok(Math.abs(r.fill - 0.6) < 0.02, `fill ${r.fill}`);
  assert.ok(r.conf > 0.9);
});

test("ignores the yellow damage trail", () => {
  const r = L.readBar(bar(0.4, [[0.4, 0, 0.3, 1, YELLOW]]), L.SPECS.hp);
  assert.ok(Math.abs(r.fill - 0.4) < 0.02, `fill ${r.fill}`);
});

test("an empty bar is low confidence, not a confident zero", () => {
  const r = L.readBar(bar(0), L.SPECS.hp);
  assert.equal(r.fill, 0);
  assert.ok(r.conf < 0.5);
});

test("scattered colour that isn't a bar is low confidence", () => {
  const blobs = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.075, 0, 0.02, 1, RED]);
  const r = L.readBar(image(160, 5, TRACK, blobs), L.SPECS.hp);
  assert.ok(r.conf < 0.6, `conf ${r.conf}`);
});

test("a box of red scenery is not a bar; a thin bar inside its box is", () => {
  const scenery = L.readBox(image(160, 9, RED), L.SPECS.boss);
  const realBar = L.readBox(image(160, 9, [40, 60, 40], [[0, 3 / 9, 0.7, 3 / 9, BOSS]]), L.SPECS.boss);
  assert.ok(scenery.conf < 0.3, `scenery conf ${scenery.conf}`);
  assert.ok(realBar.conf > 0.9 && Math.abs(realBar.fill - 0.7) < 0.02, JSON.stringify(realBar));
});

test("tracker follows the bar as it grows on level-up", () => {
  const t = L.makeTracker(0.7);
  assert.equal(L.track(t, { fill: 0.7, conf: 1 }).value, 1);
  for (let i = 0; i < 3; i++) L.track(t, { fill: 0.8, conf: 1 });
  assert.ok(Math.abs(t.full - 0.8) < 1e-9);
  const v = [0.4, 0.4, 0.4].map(f => L.track(t, { fill: f, conf: 1 }).value).pop();
  assert.ok(Math.abs(v - 0.5) < 1e-9);
});

test("tracker holds its last value through a low-confidence frame", () => {
  const t = L.makeTracker(1);
  L.track(t, { fill: 0.5, conf: 1 });
  const r = L.track(t, { fill: 0.05, conf: 0.2 });
  assert.equal(r.value, 0.5);
  assert.equal(r.conf, 0.2);
});

test("tracker smooths doubtful frames with a median but passes clean ones straight through", () => {
  const t = L.makeTracker(1);
  L.track(t, { fill: 0.9, conf: 1 });
  L.track(t, { fill: 0.9, conf: 1 });
  assert.equal(L.track(t, { fill: 0.1, conf: 0.6 }).value, 0.9, "one doubtful outlier is outvoted");
  assert.equal(L.track(t, { fill: 0.3, conf: 0.95 }).value, 0.3, "a clean drop shows at once");
});

test("scene diff is zero for the same frame and large for a cut", () => {
  const a = L.luma(image(32, 18, [40, 40, 40])), b = L.luma(image(32, 18, [200, 200, 200]));
  assert.equal(L.sceneDiff(a, a), 0);
  assert.ok(L.sceneDiff(a, b) > 0.5);
});

test("finds the player's bars, not teammates' or scenery", () => {
  const img = image(960, 540, [60, 70, 60], [
    [0.06, 0.045, 0.22, 0.009, RED], [0.06, 0.062, 0.16, 0.009, BLUE], [0.06, 0.079, 0.18, 0.009, GREEN],
    [0.03, 0.16, 0.08, 0.006, RED], [0.03, 0.2, 0.08, 0.006, RED], // teammates
    [0.3, 0.1, 0.15, 0.1, RED], // a big red rock: too thick to be a bar
    [0.25, 0.86, 0.5, 0.008, BOSS],
  ]);
  const r = L.findBars(img);
  const near = (a, b, tol = 0.006) => Math.abs(a - b) <= tol;
  assert.ok(near(r.hp.x, 0.06) && near(r.hp.y + r.hp.h / 2, 0.0495), JSON.stringify(r.hp));
  assert.ok(near(r.hp.w * r.hp.full, 0.22), "hp length");
  assert.ok(near(r.fp.y + r.fp.h / 2, 0.0665), JSON.stringify(r.fp));
  assert.ok(near(r.sta.y + r.sta.h / 2, 0.0835), JSON.stringify(r.sta));
  assert.ok(near(r.boss.x, 0.25) && near(r.boss.w, 0.5), JSON.stringify(r.boss));
});

test("finds nothing on a frame without a HUD", () => {
  assert.deepEqual(L.findBars(image(320, 180, [10, 10, 12])), {});
});

test("a lone bar-like line in a menu is not a HUD", () => {
  // Like the Relic Rites menu: a thin blue rule under the header, red icons, no player bars.
  const menu = image(960, 540, [14, 16, 30], [[0.006, 0.084, 0.08, 0.004, BLUE], [0.06, 0.25, 0.04, 0.07, RED], [0.5, 0.2, 0.04, 0.07, RED]]);
  assert.deepEqual(L.findBars(menu), {});
});

test("resolve: fresher and more confident wins, stale expires", () => {
  const s = L.makeStore();
  L.observe(s, "hp", "shot", 0.2, 0.9, 0, 30000);
  L.observe(s, "hp", "screen", 0.9, 0.95, 9000, 1500);
  assert.equal(L.resolve(s, "hp", 9100).src, "screen");
  assert.equal(L.resolve(s, "hp", 11000).src, "shot"); // live reading went stale
  assert.equal(L.resolve(s, "hp", 31000), null);
});

test("resolve: the player's correction beats every detector, and blocking a source removes it", () => {
  const s = L.makeStore();
  L.observe(s, "bossName", "claude", "Gladius", 0.9, 0, 120000);
  L.observe(s, "bossName", "manual", "Tricephalos", 1, 0, Infinity);
  const r = L.resolve(s, "bossName", 10);
  assert.equal(r.value, "Tricephalos");
  assert.equal(r.conflict, false);
  L.observe(s, "hp", "screen", 0.9, 0.9, 0, 1500);
  L.observe(s, "hp", "shot", 0.3, 0.9, 0, 30000);
  L.block(s, "hp", "screen", true);
  assert.equal(L.resolve(s, "hp", 10).src, "shot");
});

test("resolve: close disagreement about the same moment is flagged and halves confidence", () => {
  const s = L.makeStore();
  L.observe(s, "hp", "screen", 0.9, 0.8, 0, 1500);
  L.observe(s, "hp", "claude", 0.2, 0.95, 0, 30000);
  const r = L.resolve(s, "hp", 0);
  assert.equal(r.conflict, true);
  assert.ok(r.conf < 0.6, "a conflicted reading must not drive tips");
});

test("resolve: a screenshot never contradicts a live reading", () => {
  const s = L.makeStore();
  L.observe(s, "hp", "screen", 0.9, 0.8, 0, 1500);
  L.observe(s, "hp", "shot", 0.2, 0.85, 0, 30000);
  assert.equal(L.resolve(s, "hp", 0).conflict, false);
});

test("resolve: an older reading that differs is a change, not a conflict", () => {
  const s = L.makeStore();
  L.observe(s, "hp", "shot", 0.2, 0.98, 0, 30000);
  L.observe(s, "hp", "screen", 1, 0.95, 5000, 1500);
  const r = L.resolve(s, "hp", 5050);
  assert.equal(r.src, "screen");
  assert.equal(r.conflict, false);
});

const ctx = (over = {}) => ({ now: 0, mode: "combat", spoilers: true, me: "", phase: 0, next: null, ev: { bigHit: 0, bossOn: false }, ...over });
const f = (value, conf = 0.9, src = "screen") => ({ value, conf, src, age: 0 });

test("heal fires once while HP stays low, then can't repeat inside its cooldown", () => {
  const feed = L.makeFeed();
  let shown = 0;
  for (let t = 0; t <= 2000; t += 100) shown += L.updateFeed(feed, L.evaluate(ctx({ now: t, hp: f(0.2) })), t).length;
  assert.equal(shown, 1);
  assert.equal(feed.items[0].text, "Heal now");
  for (let t = 2100; t <= 3500; t += 100) L.updateFeed(feed, L.evaluate(ctx({ now: t, hp: f(0.8) })), t);
  assert.equal(feed.items.length, 0, "clears once HP recovers");
  assert.equal(L.updateFeed(feed, L.evaluate(ctx({ now: 4000, hp: f(0.2) })), 4000).length, 0, "inside cooldown");
  assert.equal(L.updateFeed(feed, L.evaluate(ctx({ now: 9000, hp: f(0.2) })), 9000).length, 1, "after cooldown");
});

test("urgent tips skip the frequency cap; other tips respect it", () => {
  const feed = L.makeFeed();
  L.updateFeed(feed, [{ key: "a", level: "info", hold: 9e9, cooldown: 0, text: "a" }], 0);
  assert.equal(L.updateFeed(feed, [{ key: "b", level: "info", hold: 9e9, cooldown: 0, text: "b" }], 1000, { minGap: 4000 }).length, 0);
  assert.equal(L.evaluate(ctx({ now: 1000, hp: f(0.1) })).length, 1);
  assert.equal(L.updateFeed(feed, L.evaluate(ctx({ now: 1000, hp: f(0.1) })), 1000, { minGap: 4000 }).length, 1);
  assert.equal(feed.items[0].level, "urgent", "urgent sorts first");
});

test("low-confidence or conflicted readings drive no tips", () => {
  assert.equal(L.evaluate(ctx({ hp: f(0.1, 0.4) })).length, 0);
  assert.equal(L.evaluate(ctx({ hp: null, sta: null })).length, 0);
});

test("modes: stamina only in combat, route only in exploration", () => {
  const next = { name: "Church", where: "north-west", why: "Flask charge" };
  assert.deepEqual(L.evaluate(ctx({ mode: "explore", sta: f(0.05), next })).map(t => t.id), ["next-stop"]);
  assert.deepEqual(L.evaluate(ctx({ mode: "combat", sta: f(0.05), next })).map(t => t.id), ["stamina"]);
});

test("spoilers off hides the Nightlord's weakness", () => {
  const on = L.evaluate(ctx({ phase: 4, weak: "holy", ev: { bigHit: 0, bossOn: true } }))[0].text;
  const off = L.evaluate(ctx({ phase: 4, weak: "holy", spoilers: false, ev: { bigHit: 0, bossOn: true } }))[0].text;
  assert.match(on, /holy/);
  assert.doesNotMatch(off, /holy/);
});

test("dropSource pulls live tips without starting their cooldown", () => {
  const feed = L.makeFeed();
  L.updateFeed(feed, L.evaluate(ctx({ hp: f(0.2) })), 0);
  L.dropSource(feed, "screen");
  assert.equal(feed.items.length, 0);
  assert.equal(L.updateFeed(feed, L.evaluate(ctx({ now: 100, hp: f(0.2) })), 100).length, 1);
});

test("quantile", () => {
  assert.equal(L.quantile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(L.quantile([], 0.5), null);
});
