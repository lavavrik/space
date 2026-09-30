# WebGPU renderer

The game renders with a renderer of our own on raw WebGPU (`src/game/gpu/`); it moved there from
three.js on WebGL2 (the port below, done 2026-09-30). The simulation, HUD, audio and saves didn't
change. three.js stays only for its maths (vectors, quaternions, matrices, and a few geometry
builders), which the simulation uses throughout. Without WebGPU the game can't run and says so.

**Where things are:** `gpu/GpuRenderer.ts` runs a frame (its header has the order of passes);
`gpu/sky.ts`, `worlds.ts` (with `terrain.ts`, `rings.ts`), `stations.ts`, `effects.ts`,
`hyperspace.ts` each own a layer; `gpu/meter.ts` and `timing.ts` do exposure metering and GPU
timing; `gpu/shaders/*.wgsl` are the shaders (`// #include name` splices a shared part, see
`shaders/index.ts`). Comments that name a `.glsl` file or `render/SceneRenderer.ts`, `Terrain.ts`,
`RingField.ts`, `Traffic.ts`, `Laser.ts`, `Hyperspace.ts` or `hdr.ts` mean the WebGL code a piece was
ported from: it's in git history before the phase 7 commit.

## Why

- **Compute shaders.** The ring belt is the heaviest thing on the GPU (~3–4 ms): every candidate
  rock runs the full vertex shader just to find out it's empty or out of range. With compute, one
  pass per frame builds the list of visible rocks and only those are drawn (indirect draw). Terrain
  chunk baking, city lights and cloud baking can move to compute the same way.
- **Precision.** Reversed-Z depth with a 32-bit float depth buffer and an infinite far plane gives
  near-uniform precision from centimetres to light-seconds. That replaces the logarithmic depth we
  write per fragment now, which disables early depth tests.
- **Control.** No engine between us and the GPU: our own frame graph, bind groups set once per
  frame, GPU timestamps per pass for the performance overlay, and later compute-based effects
  (soft shadows, reflections, ray-marched or ray-traced lighting). WebGPU has **no hardware ray
  tracing**: anything ray-traced is ours, in compute.
- **Shipping.** It runs wherever Chromium runs (Electron for a desktop build), on Vulkan (Windows,
  Linux, Android), Metal (macOS) or DX12 underneath; also Safari 26 and Firefox.

## How the port ran

Both renderers lived side by side until WebGPU matched WebGL, the game playable all along
(`?gpu=webgpu` / `?gpu=webgl` switched between them), then WebGL went.

- **Interface:** the renderer implements `GameRenderer` (`src/game/render/api.ts`): `resize`,
  `render(g)`, `dispose`, plus what the overlay and debug tools need. `Game` holds one.
- **Porting order**, each layer compared against WebGL before moving on:
  1. **Core:** device, canvas, the HDR target (rgba16float), reversed-Z depth (depth32float),
     camera-relative view, tone mapping. First layer: the sky (the Milky Way, baked once to a cube
     map, and the stars as instanced quads, since WebGPU has no sized points).
  2. **Worlds:** the star and its glow, planets (the surface shader), atmospheres, cloud decks,
     rings (the disc), dots for distant bodies.
  3. **Terrain:** LOD chunks up close, with their baked textures (compute).
  4. **Ring belt:** rocks via compute culling and indirect draw (the big win).
  5. **Stations:** hulls, interiors, the corridor and its lights, sky stations.
  6. **Ships and effects:** traffic, FTL trails, the laser, hyperspace, dust, the periscope patch.
  7. **Auto-exposure and GPU timings**, then **remove WebGL** and three.js's renderer.
- **Shaders** are ported from GLSL to WGSL by hand, one file per material under `src/game/gpu/shaders/`.

## Conventions

- **Camera-relative:** positions are world − camera in 64-bit floats on the CPU and 32-bit on the
  GPU. The camera sits at the origin.
- **Depth:** reversed-Z (near = 1, far = 0), `depth32float`, `greater` compare, infinite far plane.
- **Colour:** linear HDR in `rgba16float`, pre-multiplied by the exposure (render/exposure.ts);
  alpha carries the "physical light" share for the meter (glows and signal lights write less). The tone map is a final pass to the
  canvas (`bgra8unorm` or the preferred format).
- **Bind groups:** group 0 is per frame (frame.wgsl: camera, exposure, time, light levels), group 1
  per material or object, group 2 what's more specific still (a terrain chunk; a sky station, whose
  world's air is group 1).
- **Blending** as three.js did it: glows and signal lights add colour and multiply alpha by theirs
  (0: out of the meter); skies add and dim what's behind; clouds and ring discs blend normally.
  Transparent things are drawn far to near within each kind: glow, rings, dots, corridors, trails,
  beam, orbit ring; then skies; then cloud decks.

## Progress

- [x] **1. Core and sky** (`src/game/gpu/`):
  - The renderer switch and WebGL fallback, and the `GameRenderer` interface (both renderers implement it).
  - The HDR frame (rgba16float, 4× MSAA) with reversed-Z depth32float, and the tone map.
  - The Milky Way cube map baked in WGSL (a port of the GLSL noise and sky), and the stars as instanced quads.
  - Checked against WebGL at the galactic centre and at a nebula on another cube face: identical.
  - (The periscope patch and hyperspace came in phase 6.)
- [x] **2. Worlds** (`gpu/worlds.ts`, the WGSL in `gpu/shaders/`):
  - Ported from GLSL: the star (disc and glow), the planets' far sphere (surface, terrain as bumps, city lights), the sky shell, the cloud decks (a cube-map bake per world), the ring discs, and dots for distant bodies.
  - The GLSL includes (noise3d, terrain, atmo, clouds, city) are WGSL parts; per-world uniforms are one `World` block (world.wgsl).
  - Checked against WebGL for an Earth-like world from orbit, the star and a ringed giant: matching.
  - Not yet: the auto-exposure (phase 7; exposure stays 1), the ring's near fade (it comes with the rocks, phase 4).
- [x] **3. Terrain** (`gpu/terrain.ts`): the cube-sphere quadtree of chunks as in WebGL, baked by a
  compute shader (terrainBake.wgsl) into a storage buffer per chunk that the vertex shader reads;
  index, grid and skirt buffers shared by every chunk. Checked on a cratered moon from 4 km up.
- [x] **4. Ring belt** (`gpu/rings.ts`, rock.wgsl, rocksCull.wgsl, rocks.wgsl): the same layers, bins and
  rocks as WebGL; a compute pass per layer copy lists only the rocks that are there and in view
  (frustum-tested as spheres) and counts them into an indirect draw. Lists are sized for every
  candidate (the far speck layers ~30 MB each), so they can't overflow. Checked inside a giant's
  ring: identical to WebGL.
- [x] **5. Stations** (`gpu/stations.ts`, station*.wgsl, corridor.wgsl, skyStation.wgsl): hulls,
  interiors, the approach corridor and its lights (instanced quads), sky stations in their world's
  air (bound as group 1), and the mint beacon dots. One uniform block per station for all its
  materials. Checked: a hull from outside (as WebGL), the hangar, a sky station.
- [x] **6. Ships and effects** (`gpu/effects.ts`, `gpu/hyperspace.ts`, `gpu/sky.ts`; fx.wgsl): other
  ships' hulls (instanced), FTL trails and the orbit preview (line strips), the laser's beam, and
  every point-like thing (markers, engine glows, flashes, dust, the laser's plume) through the
  worlds' dots; hyperspace heads (the stars' pipeline) and streaks (lines, positions scaled past the
  near plane); the periscope's sky patch. Checked: a ship up close, the periscope at 40× (as WebGL),
  a hyperspace transit.
- [x] **7. Auto-exposure, timings, remove WebGL**: the meter is a compute pass over the resolved
  frame (64 px cells, alpha-weighted) read back asynchronously into render/exposure.ts's
  AutoExposure (still switched off by `AUTO_EXPOSURE`, as it was under WebGL: exposure 1, fixed light
  levels); GPU timestamps per pass for the performance overlay (docs/perf.md); the WebGL renderer,
  its GLSL, the renderer switch and three.js's renderer removed; shared constants in render/look.ts.

**Dev note:** the preview tooling serves the main checkout. For this worktree, run
`npx vite --port 5175` in it and open `http://localhost:5175/?gpu=webgpu`.
