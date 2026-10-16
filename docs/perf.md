# Performance notes

Press **`** (backquote) or open the game with `?perf` to show the performance overlay:

- FPS, plus frame time: average, 95th percentile and worst.
- CPU time per stage: sim, 3D render submission, 2D overlay, HUD snapshot.
- GPU time, where the adapter has WebGPU's `timestamp-query` feature.
- Render and overlay resolution.
- A 240-frame graph: stacked CPU stages; grey for the rest of each frame (waiting on the GPU or vsync); a cyan line for GPU time; guides at 60 and 30 fps.

## GPU time by pass

While the overlay is up, GPU time is split by pass (`gpu/timing.ts`): the compute passes (terrain bake, rock cull, meter), the shadow map, the **scene** (one pass: sky, bodies, terrain, rocks, stations and ships, the transparent things), the volumetric clouds, bloom and post (tone mapping).

**The GPU figure is the frame's span**, from the first pass's start to the last one's end, not the sum of the passes. On a tile-based GPU (Apple's) a pass's timestamps overlap the next pass's: a heavy pass's work spills past its end, and the times summed ran to 30 ms in a 9 ms frame. So the per-pass times are a rough guide only (a trivial pass after a heavy one, like post, can read several ms) and get no share of the frame.

The scene used to be drawn as six passes while the overlay was up, to time sky, far bodies, terrain, rocks, stations and ships, and transparent separately. Those times were mostly not their draws (SPACE-94): each split pass reloads and stores the 4× MSAA frame, and takes in the previous pass's spill, so a "stations, ships" pass drawing nothing read the same 6 ms as drawing them. The split now only runs for the terrain sweep below, which reads its `terrain` pass (`PerfMonitor.splitPasses`).

## Pacing

The panel's third line is the pacing: the display's refresh (estimated by the dynamic resolution, `gpu/dynres.ts`), the share of the last 240 frames that came over 1.5 refreshes (each missed a refresh and shows as a hitch), and the resolution scale. An average hides judder: at 120 Hz a GPU needing a little over 8.3 ms alternates 8 and 17 ms frames, 100 FPS on the counter and choppy on the screen. Dynamic resolution steps down only at 25 % late frames, so up to that it holds the resolution and lets frames miss.

## The frame's cost by part (Alt+`)

**Alt+`** runs the cost sweep (`debug/costSweep.ts`): each part of the frame is left out in turn for about two seconds (the scene's sky, far bodies, terrain, rocks, stations, ships, swarm, star glows, rings, dots, particles, atmospheres and cloud decks, then whole stages: the shadow map, the volumetric clouds, bloom), and its cost is how much the frame's GPU span falls without it. A baseline with everything on is measured before every four parts and at the end, and each part is compared with the baselines either side of it (interpolated in time), so a drift doesn't read as a cost. The resolution is held still meanwhile. It takes about 40 s; the picture is wrong while it runs (parts vanish in turn). The result replaces the pass list until the overlay closes, most first, as ms and a share of the frame's span, with **rest**: the span less every part's cost (the tone map, the MSAA resolve, each pass's fixed cost), and the noise level (how much the baselines varied: smaller costs are noise); it's also in the console (`console.table`, `globalThis.costSweep`). Closing the overlay stops a sweep.

Checked (2550×1317, Apple GPU, headless): at a sky station the frame's span 17 ms; terrain 6.5 ms, cloud decks 0.6, atmospheres 0.5, ships 0.4, stations 0.02, the rest within the ±0.35 ms noise. Venydes 3 from 13,000 km on its day side, with another tab of the game drawing: the noise was ±1.7 ms, and the sweep's "cloud decks 4.0" was that noise: switching the deck on and off eight times over, pair by pair, it cost 0.0 ms. Trust a cost well over the noise figure, and measure with nothing else on the GPU.

**Measuring on an Apple GPU** (what SPACE-94 learnt):
- **The GPU clocks itself down under a light load**, so at a light load times stretch to fill the frame and small costs get absorbed: headless Chrome at 60 Hz read the deck as anything from 0.5 to 2.5 ms run to run. Measure loaded: a visible window at the display's rate (the browser pane at 125 Hz read it at 3.80 ± 0.07 ms), or headless at a raised scale (`scene.setScale(2)`: 8.5 MP keeps it at full clock).
- **A hidden page stops drawing** (the pane out of view: `document.hidden`), and its numbers are worthless.
- **Switch parts off through the game's own `gpuSkip`** (`globalThis.farlightSkip` in dev builds). A test page that imports `debug/costSweep.ts` itself can get a second copy of it once the dev server has hot-reloaded the file, and switching parts off there does nothing: every part read as free, and an empty scene cost what a full one did.
- **The scene's contents, not the HUD.** In the pane, hiding the 2D HUD canvas or the HUD panels changed nothing measurable; an empty scene took 0.85 ms against 8.0 with everything drawn.

## Terrain pixel bisect (`?tdbg=<bits>`)

Open the game with `?tdbg=N` (N the sum of the bits below) and read the panel's `terrain` pass: the cost of what stays on. The bits switch parts of the ground's pixel shader (`planet.wgsl fs`) off, so the picture is wrong; only for measuring.

| Bit | Off |
|---|---|
| 1 | the finer height octaves (`terrHFrom`) |
| 2 | ground detail (patches, stones, grain, bumps) |
| 4 | the cloud layer's shadow on the ground |
| 8 | the shadow map's lookups (ships, stations, rocks) |
| 16 | the colour's noise: patches, climate, lakes |
| 32 | the sea (waves, reflection, surf) |
| 64 | the dawn valley fog |
| 128 | the ship's lamps |
| 1024 | everything: a flat grey (the floor: vertex work, rasterising, MSAA, bandwidth) |
| 2048 | the colour patches' fine octaves (part of 16) |
| 4096 | the climate's moisture and cover (part of 16) |
| 8192 | the lakes' noise (part of 16) |
| 16384 | the auroras over the ground (12 steps) |
| 32768 | the cities' population noise and lights |
| 65536 | eclipses and the ring's shadow |
| 131072 | wet ground under the overcast, snow sparkles |
| 262144 | the finer octaves' bump on the normal |
| 524288 | not the terrain's: the air's low haze (atmo.wgsl atBL), for A/B shots of the haze |
| 1048576 | skipping the ground the clouds hide (planet.wgsl hiddenByClouds): shaded anyway |
| 2097152 | not a cost: the greyer haze over nearby land (planet.wgsl vsChunk), for A/B shots |
| 4194304 | not a cost: the cirrus covering what's behind it whole, as before it faded into the haze (vclouds.wgsl fsComposite) |
| 8388608 | not a cost: the terrain's old shape (sharp ridge creases, fine gain 0.68; terrain.wgsl), GPU only, for A/B on reload |

**Shift+`** sweeps them all from where you are (`debug/tdbg.ts`): about 4 s each with the resolution held, then the terrain pass's median and mean per setting in the console (`terrainSweep` holds the rows) and on the panel. Chrome rounds GPU timestamps to ~0.13 ms unless it's started with `--enable-webgpu-developer-features`; without that, the medians all land on the same value.

## A planet from orbit (2026-10-04, SPACE-94)

Venydes 3 from 13,000 km on its day side, choppy on a 120 Hz display. In the browser pane (visible, 125 Hz, 2451×1959) the frame was 8.0 ms and an empty scene 0.85: the scene's contents, not the HUD or a fixed cost. Left out in pairs: the cloud deck 3.80 ± 0.07 ms, the terrain 2.69, far bodies 0.46, atmospheres and bloom 0.33 each, the rest nothing.

- **The cloud deck** shaded the shell's far side on every pixel of the world (drawn unculled, and its own depth write turns off the early depth test); now discarded first where the world hides it (docs/clouds.md). At 8.5 MP the frame 9.6 → 7.1 ms.
- **The terrain**, by its `tdbg` bits in pairs at 8.5 MP: all its shading 4.7 ms (flat grey), of which the sea 0.4–1.8 (with how much sunlit sea is in view; the sky in the water and its mirrored clouds most of it), the colour noise 0.6, the finer height octaves 0.35, the auroras 0.2–0.45. (Leaving the terrain out altogether saved only 2.2: the air shell's far side is then shaded where the ground hid it.) The auroras' 12-step march ran on every daylit pixel far from the ovals for nothing: now skipped when both ends of the ray's short path through their shell are in daylight or off the same side of the oval (`atmo.wgsl aurora`): 0.06–0.12 ms after, within the noise. The rest is work that shows.



On an RTX 4090 at 3132×1597, Venydes 2 from 20 km up over the overcast, the terrain pass took 1.95 ms of 3.16 (its flat-grey floor 0.39). The sweep found three parts doing work nobody saw, now skipped where they can't show (the picture is the same): the cities' population noise by day (its only use is the night lights; 0.28 ms), the lakes' finer octave where the coarse one is far from the shore's threshold (0.14 ms), and the auroras' 12-step march when the whole ray is under their shell (0.11 ms). Terrain 1.95 → 1.48 ms, GPU 3.16 → 2.69 ms.

## Terrain skirts and the periscope (2026-09-28)

Landed and looking along the ground through the periscope, the frame time rose with the zoom (here 8 → 24 ms at 750×; on a 3110×1607 screen, 8 → 57 ms). Switching parts off found it: the terrain, and within it the chunk skirts (24 → 6 ms without them).

- **Why:** the logarithmic depth buffer writes depth from the fragment shader, which turns off the GPU's early depth test. Every fragment is shaded whether or not it ends up hidden. Skirts hang below each chunk's edges, and at a grazing angle the magnified horizon strip is layer on layer of them behind the ground in front, all run through the full ground shader.
- **Fix:**
  - skirts are only as deep as a crack can be: the missing octaves' amplitude plus one vertex spacing, not four (`Terrain.ts SKIRT_SPACINGS`). A hole count on Venydes 5's mountains, with the background painted green, found the same with no skirts at all, one spacing or four;
  - below their top half, skirts get plain lit ground colour instead of the full shader. A crack only ever shows a skirt's top; at 15 % a thin line showed through.
- **Result:** 4–6 ms at 1×–750× in most views; 11 ms for a 1°-above-the-horizon view at 256×, where the ground itself stacks up.
- **The GPU split:** on Apple GPUs (tile-based: a pass is drawn all at once) the per-category timer queries each measure roughly the whole pass, so every category reads about the same. Switching things off is the reliable way there.

## Measurements (2026-09-27)

Start view (home planet large on screen, Milky Way behind it), with an emulated 2560×1440 CSS viewport at DPR 2 (a 4K-class screen). Each frame is rendered and forced to finish (`readPixels`), so these are CPU + GPU times.

| | Render size | Frame |
|---|---|---|
| Before | 3840×2160 (pixel ratio 1.5) | **30.2 ms** |
| … without the Milky Way shader | 3840×2160 | 8.0 ms |
| … without the planets and star | 3840×2160 | 24.3 ms |
| … at pixel ratio 1 | 2560×1440 | 16.7 ms |
| After: baked sky, same resolution | 3840×2160 | 7.9 ms |
| **After: baked sky + pixel budget** | 2981×1677 (ratio 1.16) | **7.1 ms** |
| … of which the planet | | ≈ 4.4 ms |
| … of which the sky | | ≈ 0.65 ms |

The 2D overlay costs about 0.04 ms of CPU per frame. Its compositing cost, and the cost of the old panel blur, can't be measured from a hidden tab.

## What changed

1. **Milky Way baked into a cube map.** The sky shader (five fBm noise evaluations per pixel) depends only on view direction, so it now runs once at startup into a 1024² cube map (≈ 25 MB). Each frame just samples that map. It stores √colour in 8 bits so the faint band doesn't show banding. This took the sky from ~22 ms to ~0.7 ms at 4K.
2. **Pixel budget for the 3D view.** The pixel ratio is `min(devicePixelRatio, 1.5, √(5 MP / CSS pixels))`. A 1080p window is unchanged; 1440p and 4K windows render about 3000×1690. The HUD and overlay stay sharp, since they're drawn separately.
3. **2D overlay canvas** capped at ≈ 8.3 MP (it was 5120×2880 on a 2560×1440 DPR-2 window).
4. **No `backdrop-filter` on HUD panels.** Blurring the live 3D view behind 7+ panels is re-done every frame. The panels are slightly more opaque instead.

## Planet shaders (2026-09-27)

A planet filling the screen was the next bottleneck: the Earth-like shader ran about 40 simplex-noise evaluations per pixel (terrain up to 13 octaves, a second terrain layer, and domain-warped clouds up to 16), on the night side too. Measured at 2981×1677 with the planet filling the view, best of several batches:

| View | Before | After |
|---|---|---|
| Earth-like, day side | 15–18 ms | 7.3 ms |
| Earth-like, terminator | 15–18 ms | 5.7 ms |
| Earth-like, night side | 15–16 ms | 2.7 ms |
| Earth-like, close (0.02 R) | 13–14 ms | 6.7 ms |
| Gas giant | 9.4 ms | 4.1 ms |
| Rocky world | 12.4 ms | 4.2 ms |

What changed (`shaders/planet.frag.glsl`, `shaders/noise3d.glsl`, `lib/noise3d.ts`):
1. **Fine octaves from a texture.** The first 3 octaves stay exact simplex noise (they set the continents and cloud patterns); finer ones read a tileable 64³ gradient-noise texture, one trilinear fetch instead of a simplex evaluation. This was the single biggest win (about 2×). Very small islands and cloud wisps differ slightly from before.
2. **Octaves per pixel:** stop once an octave is finer than the pixel's footprint on the surface (`fwidth`), cap terrain at 10 octaves (finer adds under 0.1 % contrast), the second terrain layer at 5, and cloud detail at 6. The 4-octave cloud warp is kept, since it sets the cloud pattern.
3. **Night side:** where a pixel is fully unlit (0.8 % ambient), skip the detail layers; volcanic worlds, which glow at night, are exempt.

## Further ideas, roughly by expected gain

- **Dynamic resolution:** scale the pixel ratio from the measured frame time (for example, a 60 fps target between 0.6 and the cap), so weaker GPUs stay smooth.
- **MSAA:** `antialias: true` at ~5 MP is costly in bandwidth. Consider it off when the pixel ratio is at least 1.25, or FXAA.
- ~~**Logarithmic depth buffer**~~: done with the WebGPU port (reversed-Z depth32float, infinite far plane; no fragment depth writes, so the early depth test works again).
- **Overlay:** redraw only when something moved (it currently clears and redraws every frame).
- **HUD:** React re-renders about 12×/s. That's fine now; memoise panels if it shows up in the `hud` bar.

## Dynamic resolution

`gpu/dynres.ts`: the 3D scene renders at a share of the canvas's resolution (50–100 % of the width
and height, in 5 % steps) that keeps up with the display; the final pass scales it up to the canvas,
and the HUD (its own canvas) stays sharp. The perf overlay's size line shows the share when it's under
100 %. `?fullres` in the URL turns it off.

- **Judged by frame pacing**, not the GPU timings: on Apple's tiled GPUs the passes' timestamps
  overlap (their sum read 21 ms at a steady 120 fps). The refresh interval is the shortest the
  frames have come lately (5th percentile over ~10 s).
- **Down:** every 0.5 s, if a quarter of the frames came over 1.5 intervals late while the CPU's
  own time was under 70 % of an interval (so the GPU was the one holding it up), a step down, two
  if most were late.
- **Up:** after 3 s without late frames, a step up to see. If that brings late frames within 3 s,
  it steps back, and the next try waits twice as long (up to 15 s: at a minute it stayed at half resolution long after a heavy stretch ended).
- **Can't keep up even at 50 %:** the frames settle at a slower rate, the refresh estimate follows
  them after ~10 s, and it steps back up to what that rate allows. So on a 120 Hz display it holds
  60 fps rather than sitting at 50 % for nothing.
- Each change remakes the render targets (hdr, depth, bloom, clouds, meter): cheap, but it's why
  it doesn't hunt.
- Measured at 50 % (768 × 576 of a 1536 × 1152 canvas): GPU time 16.6 → 8.0 ms looking over the
  clouds.
