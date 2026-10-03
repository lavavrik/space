# The galactic core: a black hole ~1,000 ly out

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supermassive black hole sits at a fixed point about 1,000 ly from home, in the direction where the Milky Way already looks brightest. It's a real system you can jump to. Up close it renders with lensed light paths (black shadow, photon ring, bent starfield, an accretion disk that's brighter on one side). From anywhere else it shows in the sky as a bright point to travel toward. Debug builds get shortcuts to jump straight to it and back home.

**Architecture:**
- **Galaxy.** The core is injected into its sector the way home is injected into sector 0,0,0. Its id, `systemById`, saves, `systemsNear` and the nav list then all work with no special cases.
- **Body.** The black hole is a `Star` body with a `hole` field, not a new body kind. Gravity, SOI, frames, arrival and collisions keep working through the existing star code. Its `L` is the accretion disk's luminosity, so lighting, thermal and arrival distance work too.
- **Rendering.** One lensing pass after the scene and before bloom, cut down to the hole's footprint on screen. Each pixel traces its light ray around the hole. Rays that hit the disk get the disk's emission. Rays that escape sample the scene behind (when the bent ray lands on screen) or the Milky Way cube. Rays that fall in stay black. Objects in front of the hole are left alone, using depth, like the FTL warps in `tonemap.wgsl`.

**Checks:** `npx tsc -b && npx eslint src && npx vitest run`, plus screenshots from the new debug jumps (the `run` skill).

## Fixed numbers (decided)

| | Value | Why |
|---|---|---|
| Position | `1000 · normalize(1, −0.05, 0.25)` ≈ (969.0, −48.4, 242.2) ly | `gc` in `skyBake.wgsl milkyWay()`: the direction where the band is already brightest from home |
| Sector / id | `97,-5,24`, index 0 → id `97,-5,24:0` | Sector i covers [(i−½)·10, (i+½)·10). Every sector has at least 1 system (⌊1.5⌋), so index 0 always exists |
| Jumps from home | ≈ 40 at 25 ly | |

## Proposed numbers (the mass is a decision, see the end)

Larger black holes are gentler. At the distance where the shadow looks a given size, gravity scales as 1/M. The real Sgr A* (4.3 × 10⁶ M☉) pulls about 920 m/s² where its shadow spans ~4°. The ship's normal thrust is 400 m/s², so it couldn't hold position. I propose **1 × 10⁸ M☉**, a typical galactic-core size:

| | Value |
|---|---|
| Mass | 1e8 M☉ |
| Schwarzschild radius Rs (the event horizon) | 2.95e11 m ≈ 1.97 AU |
| Shadow radius | √27⁄2 · Rs ≈ 2.6 Rs ≈ 5.1 AU |
| Disk | inner edge at ISCO = 3 Rs (5.9 AU), outer edge at 30 Rs (59 AU), tilted ~10° off the galactic plane |
| Arrival distance | 150 AU: the shadow spans ~4° and the disk ~40°; gravity there is ~26 m/s² |
| Disk luminosity `L` | 4.5e5 L☉, so `fluxDist(L, ARRIVE_FLUX)` gives exactly 150 AU, and lighting and heat at arrival match a normal system |
| Disk spin | one orbit at the ISCO takes ~12.6 h of real time. The shader's disk texture may run faster than that so the disk visibly turns |
| Planets / stations | none in this first version |

---

### Task 1: The core in the galaxy

**Files:** `src/game/constants.ts`, `src/game/types.ts`, `src/game/universe/galaxy.ts`, `src/game/universe/names.ts` (if it needs a fixed name); test `src/game/__tests__/core.test.ts`

- [x] `constants.ts`: `CORE_DIST = 1000`, `CORE_POS` (the vector above), `CORE_MASS = 1e8` (M☉).
- [x] `types.ts`: `StarInfo.hole?: true`. The record carries it, so the nav list, scanner and HUD can say "black hole" without building the system.
- [x] `galaxy.ts`: `coreSystem()` (cached like `homeSystem()`), with id `97,-5,24:0`, `pos = CORE_POS`, a fixed name, `star = { cls: 'BH', spec: 'Black hole', T: 0, R: Rs/RSUN, L: <disk L>, color: <disk colour>, hole: true }`, and no companion. `generateSector` puts it at index 0 of its sector (as it does home at 0,0,0). Derive the sector from `CORE_POS` rather than hard-coding it.
- [x] Tests:
  - `systemById('97,-5,24:0')` is the core.
  - `systemsNear(CORE_POS, 30)` contains it exactly once.
  - It is 1,000 ± 1 ly from home.
  - Home and the other systems in its sector are unchanged (same ids and seeds as before).

### Task 2: The black hole as a body

**Files:** `src/game/types.ts`, `src/game/universe/system.ts`, `src/game/sim/resources.ts`, `src/game/sim/navigation.ts`, `src/game/sim/flight.ts`, `src/game/sim/navroute.ts`; test `core.test.ts`

- [x] `types.ts`: `Star.hole?: { rs: number; diskIn: number; diskOut: number; diskAxis: Vec3 }` (all in m).
- [x] `system.ts`, `buildSystem`: if `sys.star.hole`, return `[hole]`. It is made like `makeStarBody` but with `mass = CORE_MASS · MSUN` (not `starMass(L)`), `radius = rs`, `soi = Infinity`, the disk fields set, and no `addPlanets`.
- [x] Places that assume a star is a glowing ball:
  - `resources.ts`: no corona scoop at a hole (`inZone` false).
  - `navroute.ts:454`: no scoop stop.
  - `navigation.ts arriveAt` / `flight.ts:223`: keep using `fluxDist`. It already gives 150 AU through `L`, but add a test.
  - Collisions: the existing "hit the star" check at `radius` already applies at the horizon. Check that the message reads sensibly ("crossed the event horizon").
- [x] Tests: the core's `buildSystem` returns a single star with `hole`, mass 1e8 M☉ and `radius` ≈ 2.95e11 m. The arrival distance is 150 ± 1 AU.

### Task 3: Debug jumps to the core and home, with shortcuts

**Files:** `src/game/debug/poses.ts`, `src/game/Game.ts`, `src/game/input/controls.ts`, plus the controls help list if it shows F9

- [x] `poses.ts`: two entries that every system offers, at the head of `debugSpots`:
  - `core`: "Galactic core", hint "the black hole, 1,000 ly out (F8)". Calls `arriveAt(g, coreSystem())` and then leaves FTL: `mode = 'normal'`, at rest relative to the hole, facing it, from slightly above the disk plane (~15°) so the disk reads as a disk.
  - `home`: "Home", hint "Venydes, above the home world (Shift+F8)". Calls `placeAtHome(g)`.
  - Update the header comment.
- [x] Both must cancel any jump in progress (`g.jump = null`, hyperspace guide off) and work from anywhere. `debugJump` already refuses inside a station.
- [x] `controls.ts`: `case 'F8'`: `if (DEBUG) g.debugJump(shift ? 'home' : 'core')`. F8 has no browser default, so it needs no `HANDLED` entry. (F7 toggles caret browsing, F10 opens Firefox's menu bar, F11 is fullscreen.)
- [x] Test: `debugSpots` includes `core` and `home` in any system. Optionally a small test that `core` lands you in system `97,-5,24:0`, outside FTL.

### Task 4: The lensing pass

**Files:** create `src/game/gpu/blackhole.ts` and `src/game/gpu/shaders/blackhole.wgsl`; modify `src/game/gpu/GpuRenderer.ts` (pass order), `src/game/gpu/worlds.ts` (skip the star disc and glow for a hole), `src/game/gpu/shaders/index.ts`, and `src/game/gpu/post.ts` (lens flare for a hole: from the disk's brightest part, or none)

- [x] **Where it runs:** after the opaque scene and sky, before bloom, so the disk blooms. It reads a copy of the HDR scene colour, the depth buffer, and the sky cube (`SkyLayer.cube`), and writes the frame inside a scissor rect: the projection of a sphere of radius `diskOut × 1.3`, plus a margin for the outer lensing.
- [x] **Light paths:** per pixel, take the camera's position relative to the hole (in Rs units) and the ray direction. Work in the plane that contains the hole, the camera and the ray, where `u = Rs/r` obeys `u'' = 1.5u² − u` over the angle φ. Integrate with RK4 using a step that shrinks near the photon sphere, up to ~150 steps. Stop when:
  - `u ≥ 1`: the ray fell in → black.
  - `u → 0` going outward: the ray escaped → the bent direction.
  - The ray crosses the disk plane within [diskIn, diskOut] → disk emission. Keep going for the first crossing behind as well (up to 2 crossings, for the higher-order image), adding light and dimming by the disk's opacity.
- [x] **The disk's light:**
  - Temperature `T(r) ∝ r^(−3/4) · (1 − √(r_in/r))^(1/4)` (thin-disk profile) → blackbody colour (reuse the star colour ramp if one exists).
  - Redshift factor for a circular-orbit emitter, `g = √(1 − 1.5·Rs/r) / (1 + Ω·b_z)`. Here Ω = √(Rs/(2r³)) in Rs units, and `b_z` is the photon's angular momentum about the disk axis, which is constant along the path. This combines Doppler shift and gravitational redshift. Intensity × g⁴, temperature × g, which makes the side moving toward you brighter.
  - Turbulent texture: 3D noise in (r, φ − Ω(r)·t), so the inner disk turns faster.
- [x] **Escaped rays:** project the bent direction to the screen. If it lands on screen, the scene there is behind the hole by depth, and the hole doesn't cover it, sample the scene copy (lensed stars, planets, ships). Otherwise sample the sky cube.
- [x] **Depth:** keep the original pixel wherever the scene is nearer than the hole's front (`|hole| − diskOut`). The ship, stations and anything in front stay unbent.
- [x] **Far away:** below ~3 px across, skip the pass and draw `star.wgsl`'s glow billboard in the disk's colour instead.
- [x] **Exposure meter:** follow `star.wgsl`. If the disk should count toward exposure (it lights the scene), write alpha accordingly. Check the auto-exposure doesn't pump as the disk fills the view.
- [ ] **Cost target:** ≤ 2 ms at 1440p with the disk filling the screen, using `gpu/timing.ts`. If it's over, run at half resolution with a depth-aware upsample, or bake a LUT of deflection angle against (impact parameter, camera distance). Light paths around a non-spinning hole depend only on those two.

### Task 5: Visible from anywhere

**Files:** `src/game/gpu/sky.ts`, `src/game/gpu/hyperspace.ts`, `src/game/Game.ts` (`loadSystem`)

- [x] `loadSystem`: add `coreSystem()` to `this.sky` when it's beyond `SKY_RADIUS`. Leave it out of `nearby` unless it's in jump range.
- [x] `sky.ts` / `hyperspace.ts`: its brightness is `skyLook(L, d)` with a floor, so it shows as a distinct warm point in the Milky Way's bright side from home, and grows as you approach. Optionally add a faint diffuse halo of ~1° around it.
- [x] The baked Milky Way stays as it is. Its `gc` brightening already points the right way from home. Making the band bend and brighten as you travel is the later full galaxy model in `docs/galaxy-design.md`.

### Task 6: Docs and visual check

- [x] `docs/blackhole.md`: the model, numbers, shader method and its limits (no spin, thin disk, screen-space lensing for nearby objects).
- [x] Add a pointer from `docs/galaxy-design.md`.
- [x] Screenshots using the `core` debug jump:
  - from 150 AU
  - from ~20 Rs, edge-on to the disk
  - from above the pole
  - with a planet-sized object behind the hole (check lensing and depth)
- [x] F8 / Shift+F8 round trip: core → home → core; save and load at the core.

## Decisions and status

- **Mass:** 1e8 M☉. **Name:** "Galactic Core". **Getting there in play:** the nav panel finds it by name; the route is limited by the computer's hop count.
- **Done (2026-10-02):** tasks 1–6 are in, and the final design is in `docs/blackhole.md`. Two places differ from this plan:
  - The disk's redshift factor is the static-observer form, g = √(1 − Rs/r) / (γ(1 − β cos θ)).
  - The edge-on and pole debug views were added.
- **Still open:** timing the pass on real hardware (the only test browser had a software GPU).
