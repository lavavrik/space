# Performance notes

Press **`** (backquote) or open the game with `?perf` to show the performance overlay:

- FPS, plus frame time: average, 95th percentile and worst.
- CPU time per stage: sim, 3D render submission, 2D overlay, HUD snapshot.
- GPU time, where the adapter has WebGPU's `timestamp-query` feature.
- Render and overlay resolution.
- A 240-frame graph: stacked CPU stages; grey for the rest of each frame (waiting on the GPU or vsync); a cyan line for GPU time; guides at 60 and 30 fps.

## GPU time by pass

While the overlay is up, the fourth line splits GPU time by pass (`gpu/timing.ts`): the compute passes (terrain bake, rock cull, meter), then the scene split into sky, bodies (planets, terrain, ring rocks), stations and ships, and transparent (glows, rings, dots, skies, clouds), and post (tone mapping). WebGPU times whole passes, so to split the scene it's drawn as four passes while the overlay is up (storing and reloading the MSAA target between them, which costs a little itself). Before the WebGPU port it split by shader category with WebGL timer queries.

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
  it steps back, and the next try waits twice as long (up to a minute).
- **Can't keep up even at 50 %:** the frames settle at a slower rate, the refresh estimate follows
  them after ~10 s, and it steps back up to what that rate allows. So on a 120 Hz display it holds
  60 fps rather than sitting at 50 % for nothing.
- Each change remakes the render targets (hdr, depth, bloom, clouds, meter): cheap, but it's why
  it doesn't hunt.
- Measured at 50 % (768 × 576 of a 1536 × 1152 canvas): GPU time 16.6 → 8.0 ms looking over the
  clouds.
