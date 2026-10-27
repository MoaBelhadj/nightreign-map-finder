// In-page scenarios for test/e2e.mjs: each drives the simulated HUD and checks what the overlay shows.
(() => {
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const t0 = performance.now();
  for (;;) {
    if (fn()) return Math.round(performance.now() - t0);
    if (performance.now() - t0 > ms) return null;
    await sleep(4);
  }
};
const tips = () => [...document.querySelectorAll("#hud .tip b")].map(b => b.textContent);
const liveTips = () => tips().filter(t => !t.startsWith("Next:")); // route reminders come from the plan, not the HUD
const status = () => document.querySelector("#hud").dataset.status;
const answerText = () => document.querySelector("#lv-answer").textContent;
const resolve = f => LiveCore.resolve(NMFLive.store, f, performance.timeOrigin + performance.now());
const setInput = (sel, v) => { const el = document.querySelector(sel); if (el.type === "checkbox") el.checked = v; else el.value = v; el.dispatchEvent(new Event("input")); el.dispatchEvent(new Event("change")); };
const flips = async (ms, every = 250) => { const end = performance.now() + ms; let i = 0; while (performance.now() < end) { NMFLive.sim.hp = i++ % 2 ? 0.55 : 1; await sleep(every); } NMFLive.sim.hp = 1; };
const reset = () => { NMFLive.lat.length = 0; NMFLive.e2e.length = 0; NMFLive.live.late = 0; };

window.__regress = async () => {
  for (const n of ["Recluse", "Ironeye", "Executor"]) { const b = document.getElementById("team-" + n.toLowerCase()); if (!b.checked) b.click(); }
  const blob = await fetch("sprites/gladius.jpg").then(r => r.blob());
  setFile(new File([blob], "shot.jpg", { type: "image/jpeg" }));
  for (let i = 0; i < 40 && !sample; i++) await sleep(250);
  await find();
  return { match: state.result?.best?.id, stops: state.route ? state.route.day1.length + state.route.day2.length : 0, status: document.getElementById("status").textContent };
};

window.__e2e = async () => {
  const N = NMFLive, R = { checks: [] };
  const check = (name, ok, info) => R.checks.push({ ok: !!ok, name, ...(info !== undefined && { info }) });
  N.test = true;
  document.querySelector("#lv-clear").click();

  // 1. Vertical slice: connect an input, calibrate, detect a meaningful change, show timely feedback.
  await N.connect("sim");
  check("calibrates HP, FP and stamina by itself from early frames", await until(() => N.regions.hp && N.regions.fp && N.regions.sta, 4000) != null, Object.keys(N.regions));
  N.sim.boss = 1; await sleep(250); await N.findBars(false); N.sim.boss = null;
  check("finds the boss bar when one is on screen", !!N.regions.boss);
  check("uses the worker thread", !!N.live.worker);
  check("goes live", await until(() => status() === "live", 3000) != null, status());
  await sleep(2800); // the boss bar has to stay gone 2.5 s before the fight counts as over
  const heal = [];
  for (let i = 0; i < 3; i++) {
    N.sim.hp = 1; await sleep(2600); // past the heal tip's hold and cooldown
    N.sim.hp = 0.2;
    heal.push(await until(() => tips().includes("Heal now"), 2000));
  }
  check("'Heal now' shows within 500 ms of HP dropping", heal.every(x => x != null && x < 500), heal);
  N.sim.hp = 1;
  reset(); await flips(6000);
  R.at15fps = N.report();

  // 2. Rapid scene changes and loading flashes.
  check("overlay clears once nothing is happening", await until(() => !liveTips().length, 5000) != null, tips());
  let spurious = 0, notLive = 0, hpOff = 0;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    N.sim.scene++; await sleep(75);
    if (liveTips().length) { spurious++; liveTips().forEach(t => seen.add(t)); }
    if (status() !== "live") notLive++;
    if (Math.abs((resolve("hp")?.value ?? 0) - 1) > 0.05) hpOff++;
  }
  check("40 scene changes in 3 s: no tips, stays live, HP still read right", !spurious && !notLive && !hpOff, { spurious, notLive, hpOff, tips: [...seen] });
  const ep0 = N.live.epoch;
  let sawUnsure = false;
  for (let i = 0; i < 4; i++) { N.sim.dark = true; await until(() => status() === "unsure", 400) != null && (sawUnsure = true); N.sim.dark = false; await sleep(300); }
  check("dark loading frames pause live advice, then it resumes", sawUnsure && await until(() => status() === "live", 1000) != null);
  check("each loading screen starts a new situation", N.live.epoch - ep0 >= 4, N.live.epoch - ep0);

  // 3. Capture loss.
  N.sim.hp = 0.2; await until(() => tips().includes("Heal now"), 1000);
  N.live.stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
  const lostMs = await until(() => status() === "lost" && !tips().includes("Heal now"), 1000);
  check("capture loss clears live tips at once", lostMs != null && lostMs < 50, lostMs);

  // 4. Stale capture: frames stop arriving (window minimized, capture card unplugged mid-stream).
  await N.connect("sim"); N.sim.hp = 0.2;
  await until(() => tips().includes("Heal now"), 3000);
  N.sim.frozen = true;
  const staleMs = await until(() => status() === "stale" && !tips().includes("Heal now"), 3000);
  check("a frozen capture stops confident advice within 1.5 s", staleMs != null && staleMs <= 1500, staleMs);
  N.sim.frozen = false; N.sim.hp = 1;
  check("comes back when frames return", await until(() => status() === "live", 2000) != null);

  // 5. Claude: newest question wins, answers outdated by a new situation are dropped, fresh ones reach the overlay labeled.
  await sleep(1200);
  __mock.delay = 800; __mock.reply = null;
  N.ask("what should I do");
  await sleep(150); N.sim.dark = true; await sleep(150); N.sim.dark = false;
  await until(() => !/Thinking/.test(answerText()), 3000);
  check("an answer outdated by a loading screen is dropped from the overlay", /dropped/.test(answerText()) && !tips().includes("Back off and heal"), answerText().slice(0, 120));
  await until(() => status() === "live", 1000);
  __mock.delay = 500; const ab0 = __mock.aborted;
  N.ask("first question"); await sleep(30); N.ask("second question");
  await until(() => !/Thinking/.test(answerText()), 3000);
  check("the newest question wins and the older one is cancelled", /second question/.test(answerText()) && !/first question/.test(answerText()) && __mock.aborted > ab0);
  check("fresh Claude advice reaches the overlay, labeled as Claude's", tips().includes("Back off and heal") && /Claude saw/.test(document.querySelector("#hud").textContent));
  check("Claude received the live frame", __mock.calls.at(-1)?.images === 1, __mock.calls.at(-1));

  // 6. Several inputs at once, with conflicting observations.
  await sleep(500);
  const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
  LiveCore.drawSim(c.getContext("2d"), 1280, 720, { hp: 0.2, fp: 0.8, sta: 1, boss: null, scene: 3 });
  const file = new File([await new Promise(r => c.toBlob(r, "image/png"))], "shot.png", { type: "image/png" });
  __mock.delay = 300; __mock.reply = { seen: ["A boss bar labeled Night Boss"], boss: "Night Boss", advice: ["Dodge left"], answer: "Dodge." };
  setInput("#lv-boss", "Tricephalos");
  await Promise.all([N.useShot(file), N.ask("is the boss enraged?"), N.voice("combat")]);
  check("a live reading beats an older screenshot, without a conflict", resolve("hp")?.src === "screen" && resolve("hp").value > 0.9 && !resolve("hp").conflict, resolve("hp"));
  check("your typed boss name beats Claude's reading", resolve("bossName")?.value === "Tricephalos" && N.store.obs.bossName?.claude?.value === "Night Boss", resolve("bossName"));
  check("a voice command applied while other inputs ran", N.S.mode === "combat");
  setInput('[data-ignore="hp"]', true); await sleep(200);
  check("ignoring the live HP falls back to the screenshot", resolve("hp")?.src === "shot" && resolve("hp").value < 0.3, resolve("hp"));
  check("screenshot readings never trigger live tips", !tips().includes("Heal now"), tips());
  setInput('[data-ignore="hp"]', false); setInput("#lv-boss", ""); N.voice("auto mode");

  // 7. Pause and mute.
  N.sim.hp = 0.2; await until(() => tips().includes("Heal now"), 1500);
  N.setPaused(true);
  check("pause clears tips immediately", status() === "paused" && !tips().length);
  N.setPaused(false); N.sim.hp = 1;

  // 8. Performance: analysis rate sweep, then a page thread that is busy two thirds of the time.
  R.rates = {};
  for (const fps of [5, 15, 30]) {
    setInput('[data-set="fps"]', fps); await sleep(400);
    reset(); await flips(5000);
    R.rates[fps] = N.report();
  }
  setInput('[data-set="fps"]', 15); await sleep(400);
  reset();
  const busy = setInterval(() => { const t = performance.now(); while (performance.now() - t < 40); }, 60);
  await flips(6000);
  clearInterval(busy);
  R.underLoad = N.report();
  N.stopCapture();
  R.passed = R.checks.filter(x => x.ok).length; R.failed = R.checks.filter(x => !x.ok).length;
  return R;
};

// Inside a frame that forbids screen capture (as claude.ai's does): the page must say how to get live capture, not just that it's blocked.
window.__framed = async () => {
  const f = Object.assign(document.createElement("iframe"), { src: "nightreign-map-finder.html", allow: "display-capture 'none'" });
  f.style.cssText = "width:1200px;height:800px";
  document.body.append(f);
  await new Promise(r => f.addEventListener("load", r, { once: true }));
  await sleep(1500);
  const d = f.contentDocument, local = d.querySelector("#lv-local"), link = local?.querySelector('a[href^="http://localhost"]');
  const out = { shareDisabled: d.querySelector("#lv-screen").disabled, status: d.querySelector("#lv-status").textContent,
    help: !!local && !local.hidden, mentionsCmd: /start-live\.cmd/.test(local?.textContent || ""), link: link?.getAttribute("href") || null };
  f.remove();
  return out;
};

// The always-on-top pop-out: the overlay moves into its own window and comes back when it closes.
window.__pip = async () => {
  const b = document.querySelector("#lv-pop"), out = { supported: "documentPictureInPicture" in window };
  b.click();
  out.opened = await until(() => !document.querySelector("#hud-home #hud"), 2000) != null;
  out.label = b.textContent;
  out.size = window.documentPictureInPicture?.window && [documentPictureInPicture.window.innerWidth, documentPictureInPicture.window.innerHeight];
  out.styled = getComputedStyle(documentPictureInPicture.window?.document.body || document.body).backgroundColor;
  b.click();
  out.back = await until(() => !!document.querySelector("#hud-home #hud"), 2000) != null;
  return out;
};

// Real screen-capture path: getDisplayMedia on a window titled "Latency test" (auto-picked by a browser flag), worker, overlay.
window.__capture = async ms => {
  const N = NMFLive;
  if (!N.live.stream) {
    document.querySelector("#lv-clear").click();
    await N.connect("screen");
    if (!N.live.stream) return { error: document.querySelector("#lv-status").textContent };
    await sleep(1500);
    await N.findBars(false);
  }
  reset();
  await sleep(ms);
  return { found: Object.keys(N.regions), thread: N.live.worker ? "worker" : "page", hidden: document.hidden, report: N.report(), status: status() };
};
})();
