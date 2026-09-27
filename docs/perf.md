# Performance notes

Press **`** (backquote) or open the game with `?perf` to show the performance overlay:

- FPS, plus frame time: average, 95th percentile and worst.
- CPU time per stage: sim, 3D render submission, 2D overlay, HUD snapshot.
- GPU time, where the browser exposes `EXT_disjoint_timer_query_webgl2`.
- Render and overlay resolution, draw calls, triangles, points and lines.
- A 240-frame graph: stacked CPU stages; grey for the rest of each frame (waiting on the GPU or vsync); a cyan line for GPU time; guides at 60 and 30 fps.

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

What changed (`shaders/planet.frag.glsl`, `shaders/noise3d.glsl`, `render/noise3d.ts`):
1. **Fine octaves from a texture.** The first 3 octaves stay exact simplex noise (they set the continents and cloud patterns); finer ones read a tileable 64³ gradient-noise texture, one trilinear fetch instead of a simplex evaluation. This was the single biggest win (about 2×). Very small islands and cloud wisps differ slightly from before.
2. **Octaves per pixel:** stop once an octave is finer than the pixel's footprint on the surface (`fwidth`), cap terrain at 10 octaves (finer adds under 0.1 % contrast), the second terrain layer at 5, and cloud detail at 6. The 4-octave cloud warp is kept, since it sets the cloud pattern.
3. **Night side:** where a pixel is fully unlit (0.8 % ambient), skip the detail layers; volcanic worlds, which glow at night, are exempt.

## Further ideas, roughly by expected gain

- **Dynamic resolution:** scale the pixel ratio from the measured frame time (for example, a 60 fps target between 0.6 and the cap), so weaker GPUs stay smooth.
- **MSAA:** `antialias: true` at ~5 MP is costly in bandwidth. Consider it off when the pixel ratio is at least 1.25, or FXAA.
- **Logarithmic depth buffer:** writing `gl_FragDepth` disables early-z, so hidden fragments are still shaded. The camera-relative scene could instead use a reversed-Z float depth buffer (WebGL2 + `EXT_clip_control`) or per-object depth ranges.
- **Overlay:** redraw only when something moved (it currently clears and redraws every frame).
- **HUD:** React re-renders about 12×/s. That's fine now; memoise panels if it shows up in the `hud` bar.
