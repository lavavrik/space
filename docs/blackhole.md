# The galactic core

A supermassive black hole, the **Galactic Core**, sits 1,000 ly from home (about 40 jumps), toward the Milky Way's brightest stretch: `gc` in `skyBake.wgsl milkyWay()`, so the sky already points at it. The plan is in `docs/superpowers/plans/2026-10-02-galactic-core-black-hole.md`.

## In the galaxy (`universe/core.ts`)

- **Where:** `CORE_DIST · normalize(CORE_DIR)` ≈ (969.0, −48.4, 242.2) ly (`constants.ts`). It's index 0 of its sector, `97,-5,24`, which `galaxy.ts generateSector` fills with `coreSystem()` the way it fills 0,0,0 with home. So its id (`97,-5,24:0`), `systemById`, saves, `systemsNear` and the nav list need nothing special. The sector's other systems are unchanged (the core takes index 0's place after its position draw).
- **The record:** a `StarInfo` with `hole: true`: class `BH`, `R` its horizon, `L` and colour its disk's.
- **In sight from anywhere:** `Game.loadSystem` adds it to the sky list past `SKY_RADIUS`, and so does the hyperspace view. `skyLook(…, beacon)` doesn't fade it out and keeps it at least as big and bright as the brightest near star: a warm point in the Milky Way's bright stretch. Typing its name in the nav panel plots a route to it (within the computer's hop limit).

## The body (`universe/system.ts makeHole`)

A `Star` with a `hole` field (`rs`, `diskIn`, `diskOut`, `diskAxis`) and no planets or stations. It's a star body, not a new kind, so gravity, SOIs, frames, arrival, respawn and collisions work through the star code as they are.

| | Value | Why |
|---|---|---|
| Mass | 1e8 M☉ | Where the shadow looks a given size, the pull goes as 1/M. At Sgr A*'s 4.3e6 it's ~900 m/s² there, past the ship's 400 m/s² thrust; at 1e8, ~26 m/s² |
| Horizon (Rs = 2GM/c²) | 2.95e11 m ≈ 1.97 AU | |
| Shadow | √27⁄2 Rs ≈ 2.6 Rs | |
| Disk | 3 Rs (the innermost stable orbit) to 30 Rs, tilted ~10° off the galactic plane | |
| Arrival | 150 AU (`CORE_ARRIVE`): the shadow ~4° across, the disk ~40° | |
| Disk luminosity | 4.5e5 L☉ (`DISK_L`): `ARRIVE_FLUX` at 150 AU | `arriveAt`, lighting, heat and respawn work as at a star |

- **No corona to skim:** `resources.ts` skips it, and route refuel stops aren't planned there.
- **Crossing the horizon** destroys the ship ("Crossed the event horizon of …").
- **The HUD** reads "Black hole · 1e8 M☉ · horizon 1.97 AU".

## Rendering (`gpu/blackhole.ts`, `blackhole.wgsl`)

One pass over the resolved frame, after the scene (and the clouds) and before the exposure meter and bloom, so the disk blooms. The frame is copied, then drawn back over itself inside a scissor rect: the lens sphere's (100 Rs) footprint on screen, or the whole view once you're inside it. The star's disc and glow (`star.wgsl`) are skipped for a hole.

- **Light paths:** traced back from the camera in Rs units, with velocity Verlet on `x'' = −(3/2) h² x / r⁵` (the Schwarzschild photon orbit in Cartesian form, h the ray's angular momentum). The step is 0.07 r (fine round the photon sphere), up to 220 steps. A ray ends when:
  - **it falls in** (r < 1): black;
  - **it escapes the lens:** whatever lies along its bent direction. That's the frame where it lands on screen and nothing nearer than the hole covers that spot (stars and anything else behind it get lensed), otherwise the Milky Way cube (as `sky.wgsl` shades it).
- **The disk:** each crossing of its plane within [3, 30] Rs adds its light, front to back by its opacity, so the far side bent over and under the shadow shows too.
  - **Temperature:** the thin-disk profile, r^−¾ (1 − √(r_in/r))^¼, 7,500 K at its peak, as a blackbody colour.
  - **Redshift factor:** g = √(1 − Rs/r) / (γ (1 − β cos θ)), with β = √(M/(r − 2M)), the orbit's speed as a static observer sees it. Colour temperature × g, intensity × g⁴: the side coming toward you is several times brighter than the other.
  - **Texture:** turbulent streaks in polar coordinates, each ring turned at its own Ω = √(M/r³), sped up 50× (an inner orbit takes ~15 min, not 13 h).
  - **No winding up:** turned for ever, the shear wound the texture into rings finer than a pixel (moiré within hours of game time). Instead there are two layers, each laid down afresh every 40 Rs/c of the disk's clock (~13 min), half a period apart and crossfaded, so the texture is never wound more than one period's worth (~5 rad between the inner and outer edges).
  - **Detail by pixel size:** each noise octave fades out where its features would be finer than ~2 px. The footprint is the pixel's angle times the ray's path so far, widened by 1 + 3 × how far the ray has been bent, because the images squeezed round the hole are the ones that sparkled.
  - **Brightness:** display-referred, like the star's (`DISK_K`), with alpha 0 so it doesn't drive the exposure meter.
- **What's in front:** where the depth says the frame is nearer than the lens's near side (or halfway to the hole, from inside the lens), it's left as it is. The depth is kept for this pass, as it is for the warps.
- **No seam:** the bend is eased out by impact parameter from 60 to 100 Rs, so the lens's edge doesn't show.

## Debug jumps (`debug/poses.ts`)

- **F8 / "Galactic core":** 150 AU out, 15° above the disk, at rest, facing it.
- **Shift+F8 / "Home":** above the home world, as at a new game.
- **At the core**, "Black hole edge-on" (40 Rs out, 4° above the disk) and "Black hole from the pole" (60 Rs over it).

## Limits

- **No spin:** a Schwarzschild hole, not a Kerr one, so the shadow is round and the disk symmetric round it.
- **A thin disk:** no thickness, so edge-on it's a line.
- **Lensing of nearby objects is screen-space:** what's behind the hole but off screen comes from the Milky Way cube, without the sky's stars. A planet-sized object behind it would be lensed only where it's on screen (there are none at the core).
- **Cost:** the trace runs per pixel over the footprint. It hasn't been timed on real hardware yet (the perf overlay's "black hole" line). If it's over ~2 ms, run it at half resolution, or bake the deflection into a LUT by (impact parameter, camera distance).
