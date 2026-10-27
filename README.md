# Nightreign Map Finder

A companion page for Elden Ring Nightreign.

- **Map finder** (needs Claude): drop a map screenshot at the start of an expedition. Claude matches it against all 520 map patterns and plans a route for your team.
- **Live companion**: while you play, it reads your HUD bars and shows short tips, either on the page, in a small always-on-top window over the game, or full screen on a second monitor.

## Two ways to open it

| | Claude version (claude.ai link) | Local copy (`start-live.cmd`) |
|---|---|---|
| Map matching and route plans | Yes | No (you can still browse the patterns) |
| Live screen capture | Only if claude.ai's frame allows it. The page checks, and says so if it doesn't. | Yes |
| Pop-out window over the game | No: browsers only allow it in a top-level page | Yes |
| Screenshot reading | Yes | Yes |
| Questions to Claude, with the frame | Yes, on screenshots | No: quick answers only (weakness, next stop, readings) |

Use the Claude version before a run to find your map and plan a route. Use the local copy during the run for live tips. Getting Claude's answers on live frames in the local copy is the main next step (see the end).

## Setup for live play (local copy)

1. Keep Nightreign's **Screen Mode on Borderless**. Yours already is (`%APPDATA%\Nightreign\GraphicsConfig.xml` says `BORDERLESS`). An always-on-top window can't show over exclusive Fullscreen.
2. Double-click `start-live.cmd`. It serves this folder on `http://localhost:8787` with Python and opens Edge at the Live companion.
3. Press **Share game window** and pick the **ELDEN RING NIGHTREIGN** window, not the whole screen. That way the overlay is never part of what gets read.
4. In game, with the HUD showing and **full HP**, open *Calibrate HUD* and press **Find bars**. Check the coloured boxes on the preview. If one is wrong, pick that bar and drag a box around it. Press Find bars again during a boss fight to add the boss bar.
5. Set **You play** to your Nightfarer, and the Phase as the run goes (or press D).
6. Press **Pop out over game**. A small window opens that stays on top of the game; drag it off the HUD (the right edge works well). Or move the page to your second monitor (1920×1080) and press **Full screen**.
7. Optional: press **Voice** to use commands without leaving the game: "next", "back", "mute", "unmute", "pause", "resume", "combat", "explore", "auto mode", "next phase". Anything else is treated as a question.

Hotkeys work only while the page or the pop-out has focus: P pause, M mute, 1/2/3 auto/combat/exploration, N next stop (Shift+N back), D next phase, Q ask about now, V voice, O pop-out, S spoilers.

## What it reads, and what it doesn't

Read locally from pixels, about 15 times a second:

- HP, FP and stamina, as a percentage of the bar
- the boss health bar: whether it's showing, and its percentage
- dark or loading screens
- big scene cuts

Each reading carries its source, its age and a confidence. The overlay labels facts as *Seen: …* and keeps them apart from the advice they lead to.

Not read locally: boss names, status effects, equipped items, menus, runes, the day timer. On request, Claude can read these from the frame or screenshot you send, and its answer lists *What Claude could see* separately. You can also type a boss name: your correction always outranks Claude's.

When the reading isn't trustworthy, live advice stops instead of guessing. That covers:

- no new frames for 1 s (for example, the window is minimized)
- the HUD bars aren't visible (menu, map, cutscene)
- the screen is dark (loading)
- the capture ended

The overlay then says why. Tips from your route plan, labeled *Plan: …*, still show.

Tips come from a few short rules:

- Heal now
- Big hit, back off
- Out of stamina (combat only)
- Low FP (casters only)
- Boss fight, with the Nightlord's weakness when spoilers are on and the phase is Day 3
- Boss under 20%
- Next route stop (exploration only)

A tip stays while it applies, then clears. After that it can't come back within its cooldown, and non-urgent tips respect the minimum gap you set. Urgent tips always show first.

## Measured latency

Measured with `node test/e2e.mjs` on this PC (headless Edge 155, RTX 3080 Ti), October 2026.

| What | Median | 95th percentile |
|---|---|---|
| Detection per frame, in the worker | 8 ms | |
| Frame arrival → overlay painted | 15 ms | 18 ms |
| HP change on screen → overlay updated, analysis at 5 / 15 / 30 per second | 136 / 49 / 20 ms | 233 / 85 / 61 ms |
| HP drops → "Heal now" shown (3 tries per run) | 14–84 ms | |
| Real screen-capture path (window share), page visible | 91 ms | 111 ms (6 changes) |
| Same, page window minimized, as when it's behind the game | 71 ms | 119 ms (6 changes); the worker kept 12 readings/s |
| Page thread busy two thirds of the time | 97 ms | 134 ms |
| Capture frozen → live advice stopped | ~1.0–1.1 s (by design: 1 s without frames) | |
| Capture ended → live advice stopped | immediately (same event) | |

Not measured:

- **Capturing the real game window.** It goes through Windows' capture, which usually adds a frame or two.
- **The game's frame rate with capture running.**
- **Claude's real answer time.** Tests used a stand-in. Claude's docs say fast answers take about 1–2 s and thorough ones 5–60 s, which is why Claude is never in the fast path.

To measure your own setup, open `http://localhost:8787/latency-test.html` in its own window. Share that window from the Live companion, press Find bars, wait 20 seconds, then press **Copy latency report**.

## Known limitations

- **The HUD reader hasn't seen a real in-run frame yet.** It was tested on a simulated HUD drawn like Nightreign's bars, and on your one saved Nightreign screenshot, a Relic Rites menu: it correctly found no bars there and rejected a blue header line that first fooled it. On your first run, check the Find bars preview. Colour filters, HDR or ReShade can shift the bar colours outside the hue windows in `live-core.js` (`SPECS`).
- **Calibrate at full HP.** The read box extends past the bar so it can follow the bar growing on level-up, but a box found at half HP is too short: everything above about two thirds then reads as full. If that happens, press Find bars again once you're full.
- **The pop-out window** is opaque, can't be clicked through, and its position is set by dragging. Any window over the game may stop Windows from using its fastest present mode, which can cost a little game performance. If you notice it, use the second monitor instead.
- **Hotkeys need focus** on the page or the pop-out. Browsers can't register global hotkeys; voice is the hands-free option.
- **Voice** uses Edge's speech service, which sends audio to Microsoft while Voice is on. It wasn't tested here (no microphone in the test run); only the command handling was.
- **Capture cards** use the same path as cameras but weren't tested here (no device).
- **Other browsers**: without Edge or Chrome's `MediaStreamTrackProcessor`, the page falls back to reading frames on its own thread. That slows down when the tab is hidden and can't tell a frozen capture from a still scene.
- **Game data**: no permitted live-data source exists. FromSoftware publishes no live game API, reading the game's memory or modding it conflicts with Easy Anti-Cheat, and Steam's Web API only has achievements. So pixels on screen are the only source. The tool never touches the game, its memory or its files, and never presses anything for you.

## Privacy

- Frames are analyzed in memory and dropped. Nothing is recorded, saved or uploaded.
- Claude only gets a frame when you ask a question: one JPEG, at most 1600 px wide. In the local copy, Claude isn't available at all.
- Settings and calibration boxes stay in this browser's local storage.

## How to make it faster or smarter next

1. **Set Analysis rate to 30** (*Overlay and performance*). In tests this halved the time from change to tip (49 → 20 ms median). Detection costs about 8 ms a frame, so this is cheap.
2. **Measure on the real game** with `latency-test.html` and the latency report, and check the game's FPS with and without capture running.
3. **Refine colours from your HUD**: at calibration, sample each bar's actual hue instead of using fixed windows.
4. **Claude on live frames**: artifacts opened in the Claude desktop app can call a local MCP server. A small one that the local copy feeds with the latest frame and readings would let the Claude version answer about the live game. This is untested, so check it before building on it.
5. **Local boss-name reading**: OCR the boss name above the boss bar when it appears (for example Tesseract.js in the worker), so it doesn't need a Claude call.
6. **Native overlay** (Tauri or Electron) for a transparent, click-through window and global hotkeys, only if the pop-out's limits get in the way.

## Adding an input

Every input writes observations into one store: `LiveCore.observe(store, field, source, value, confidence, time, ttl)`. `resolve()` then picks the winner:

- your corrections beat everything else
- among the rest, the freshest, most confident reading wins
- readings of the same moment that disagree are flagged and stop driving tips

A new source (for example an OCR reader) only has to call `observe` with its own source name, and add a weight to `WEIGHT` in `live-core.js`.

## Tests

```bash
node --test test/live-core.test.js
```

```bash
node test/e2e.mjs
```

The first runs 24 unit tests. The second drives the real page in headless Edge: simulated HUD, real window-capture path, pop-out, rapid scene changes, several inputs at once, conflicting readings, capture loss, stale frames, outdated Claude answers and load. It needs Python and Edge. `build/` holds the map finder's data scripts and its older test harness.
