# Galaxy design: navigable sky and a procedural Milky Way

Status: **Step 1 (§2) is implemented** as a local cluster only, with these choices:
- 100 systems on average within the 25 ly jump range (`STARS_IN_RANGE`; first tried 170, which felt too crowded). Measured over 500 random points: mean 100, σ ≈ 5, range 86–116.
- `SKY_RADIUS` = 100 ly (about 6.5k sky points; the query took ~12 ms per jump at the old density).
- Uniform density with no edge. The cluster is unbounded, but the jump range keeps travel local.
- Decorative sky stars removed; the Milky Way band shader stays as unresolved background.
- Home is still Venydes (sector 0,0,0, star 0, at the origin). Every other system changed.

§3 (the full galaxy) is deferred.

## 1. How it works today

| Piece | File | What it does |
|---|---|---|
| Galaxy | `src/game/universe/galaxy.ts` | 110 `StarSystem` records generated up front from `GALAXY_SEED`, uniformly in a 120 × 18 × 120 ly box. System 0 (home) is at the origin. |
| Star summary | `universe/stars.ts`, `names.ts` | Each record holds only `pos`, `seed`, `name`, `star` (class, T, R, L). Names are made unique with a global `Set`. |
| System contents | `universe/system.ts` | `buildSystem(sys)` builds planets and moons from the seed **only when you arrive** (`Game.loadSystem`). |
| Jump range | `constants.ts` `JUMP_RANGE = 25` ly; `sim/navigation.ts` `reachable()` | Filters all 110 systems by distance; `N` cycles them, `H` jumps. |
| Sky | `render/SceneRenderer.ts` `buildSky()` / `buildSysStars()`; `shaders/sky.frag.glsl` | Three layers: (a) a Milky Way band shader with a **fixed** galactic plane, (b) **11,000 decorative random points** (seed 777) that are not real systems, (c) the other 109 real systems as points, brightness by flux. |

Good news: the architecture already follows the "summary record now, contents on arrival" pattern. A system is a cheap record (`pos + seed + star`) until you jump there, and only then do its bodies exist. That is the core No Man's Sky idea. What's missing is making the *set of records* lazy and infinite instead of a fixed array.

Problems for the goal:
- The 11k sky points are fake: you see stars you can never reach, and the real systems look the same as the decoration.
- The box is only 120 ly across with a 25 ly range, so a handful of jumps crosses the whole "galaxy".
- Density is about 0.00042 stars/ly³. The real solar neighbourhood is about 0.004/ly³, 10× denser. Real density puts roughly 260 stars within 25 ly.
- `g.systems` is a fixed array, and the code assumes that in many places: `reachable`, `buildSysStars`, name uniqueness, `id` as an index, and the tests.

## 2. Step 1: a sky made only of navigable stars, reachable within a radius

Goal: every star point in the sky is a real system. Stars inside `JUMP_RANGE` can be targeted and jumped to, and farther ones are visible but out of range.

### 2.1 Sector-based generation (replaces the fixed array)
- Split space into cubic **sectors** (for example 10 ly). A sector's contents are a pure function of `(GALAXY_SEED, ix, iy, iz)`:
  ```ts
  sectorSeed = hash32(GALAXY_SEED, ix, iy, iz)   // splitmix/xxhash-style integer hash
  count      = poisson(rng, density(center) * SECTOR_VOL)
  for k < count: pos = cellOrigin + rng()*size, seed = hash32(sectorSeed, k), star = makeStar(...)
  ```
- A stable id is `"ix:iy:iz:k"` instead of an array index. Use it for saves, `jumpDest` equality, and caching.
- `galaxy.query(center, radius): StarSystem[]` walks the overlapping sectors, keeps an LRU cache of generated sectors, and filters by distance.
- Home: force sector `(0,0,0)` star `0` to the current home (same retry-the-seed loop as now), so the start stays pinned.
- Names: a global uniqueness `Set` can't work lazily. Derive names from the seed and accept rare duplicates, or add a coordinate-based catalogue designation (Elite-style "Venydes (FL-0:3:-2-1)").

### 2.2 Sky rendering
- Delete the 11k decorative points, or keep a very faint copy only as unresolved "glow" under the Milky Way band.
- `buildSysStars` uses `galaxy.query(cur.pos, SKY_RADIUS)`. Pick a `SKY_RADIUS` of about 60–150 ly: about 3.6k stars at 60 ly, about 56k at 150 ly (at real density). Both are fine for one `THREE.Points`.
- Brightness stays flux-based (already the case), so nearby and luminous stars dominate naturally.
- Tint in-range stars, or mark them on the overlay (`render/Overlay.ts`), so reachability is readable at a glance.

### 2.3 Navigation
- `reachable()` becomes `galaxy.query(galPos, JUMP_RANGE)`.
- At real density there are about 260 candidates, too many to page through with `N`. Add **aim-to-target for stars** (like `targetAhead` for bodies, but against sky directions), and keep `N` as "cycle nearest 10".
- Optional gameplay knob: make the range depend on the ship (drive upgrade, exotic matter) rather than a constant.

### 2.4 Tests to add/update
- The same sector gives the same stars (determinism), and neighbouring sectors don't overlap.
- `query` returns exactly the stars within the radius (brute-force check over sectors).
- Home is still pinned (`Venydes`, G4 V, Earth-like with a moon).
- Mean density within tolerance of `density()`.

**Size:** roughly 2–3 days. It's mostly `galaxy.ts`, `navigation.ts`, `SceneRenderer.buildSysStars/buildSky`, `Game.systems`, the HUD star picker, and the tests.

## 3. Step 2 and beyond: the whole Milky Way, No Man's Sky style

The real thing has 100–400 billion stars in a disk about 100k ly across and about 1k ly thick. Nothing can be stored. Everything must be a **pure function of coordinates**, evaluated only near the player. Only player-made changes are persisted.

### 3.1 Galaxy density model
Replace the uniform density with `density(x)` (stars per ly³):
- **Thin/thick exponential disk:** `ρ0 · exp(-R/Rd) · exp(-|z|/h)`, with Rd ≈ 8.5k ly and h ≈ 1k ly.
- **Bulge + bar** near the centre, and **spiral arms** as a log-spiral modulation of the disk.
- Put home in the disk about 26k ly from the centre, in an arm, so the local density is about 0.004/ly³ and the sky looks right.
- Star class mix varies with position: more young O/B stars in the arms, older/redder stars in the bulge. Add non-main-sequence objects later: giants, white dwarfs, neutron stars, black holes, binaries, nebulae.
- The core already has its black hole, at a fixed point 1,000 ly out in the bright stretch of today's Milky Way bake (docs/blackhole.md). A galaxy model would centre on it.

Because sectors use Poisson counts from `density(center)`, step 1's generator just works. Also, empty space is free: a cell with λ ≈ 0 costs a hash and nothing more.

### 3.2 Level of detail for the sky
Three layers, all derived from `density()` and the player's position:
1. **Near field** (≤ ~100–200 ly): individual real systems from sector queries, as in step 1. Only these can be jump targets.
2. **Mid field** (~200 ly – a few kly): coarse cells (for example 100 ly) that emit only their few *brightest* stars as points, sampled statistically. They can be seen but not targeted until you get close.
3. **Far field**: the Milky Way glow. Replace the fixed-plane `sky.frag.glsl` with a **position-dependent cubemap**. On each arrival, raymarch `density()` plus a dust-extinction field from the ship's galactic position into a cubemap on the GPU (a few ms). Travel toward the core and the band thickens, brightens and bends. Leave the disk and you see the spiral from above.

### 3.3 Precision
Galactic coordinates in ly as JS doubles are fine: at 1e5 ly the resolution is about 1e-11 ly (about 100 km). In-system positions stay in metres relative to the system origin, and rendering is already camera-relative (`SceneRenderer`), so nothing changes there. Sector indices are small integers (±5k at 10 ly), so a 32-bit hash is fine.

### 3.4 "Exists only as a target until you navigate there"
Already true for bodies. To extend it:
- **Star record** (cheap, generated by sector query) → **system** (`buildSystem`, on arrival) → **surface** (not yet: landing currently uses an analytic sphere).
- True NMS-style planet surfaces need a chunked quadtree cube-sphere terrain with streamed LOD meshes from the same noise the shaders use. This is the single biggest item, a separate multi-week project.

### 3.5 Persistence
The only state to store is a sparse diff keyed by stable id, in IndexedDB/localStorage: visited/discovered systems, player-given names, depleted resources, ship state, and current system id plus position. Everything else regenerates identically.

### 3.6 Gameplay and UI needed at galaxy scale
- **Galaxy map:** a separate view that renders `density()` as a 2D/3D map plus near-field stars around a cursor. This is the biggest UI piece.
- **Route planner:** A* over the star graph, where neighbours come from `galaxy.query(node, JUMP_RANGE)` on demand. Reaching the core from home is about 26k ly / 25 ly ≈ 1,000+ jumps, so the jump range and cost (`jumpCost = 2 + 0.02·ly²` kg) need rebalancing, or a long-range drive tier.
- **Discovery/scanner:** reveal star class and planets before arrival (a small, cheap preview via `buildSystem` without rendering).

### 3.7 Rough roadmap

| Phase | Content | Size |
|---|---|---|
| 1 | Sector generator, local-only sky, range-limited targeting (§2) | 2–3 days |
| 2 | Galaxy density model, home placed in the disk, mid-field stars, dynamic Milky Way cubemap | ~1 week |
| 3 | Galaxy map, route planner, persistence of discoveries | 1–2 weeks |
| 4 | Stellar variety (giants, remnants, binaries, nebulae) | ~1 week |
| 5 | Landable procedural planet surfaces (terrain LOD streaming) | weeks to months |

Phase 1 is designed so phases 2–3 only swap `density()` and add views. The generator, ids and queries stay the same.

## 4. Open decisions
- **Density:** realistic (about 260 stars in jump range, so aim-targeting is needed) or thinned to about 20–50 for a gamier "pick from a list" feel?
- **Sky radius vs jump range:** how far do you see individual stars beyond what you can reach (for example 25 ly range, 100 ly sky)?
- **Decorative background:** drop the fake 11k stars entirely, or keep them faint as unresolved glow until phase 2 replaces the far field?
- **Scope:** stop at phase 1 (bounded local cluster), or commit to the phase 2 galaxy model now, which decides where home sits and the coordinate frame?

## 5. How big is the galaxy's data?

Measured on 2026-09-26 (Node heap, current code).

**Stored or shipped: effectively nothing.** The whole galaxy is one 32-bit number (`GALAXY_SEED`) plus about 530 lines of generator code (`universe/*.ts`, `lib/rng.ts`). Every star, planet, moon, station and orbit is recomputed from the seed and its coordinates on demand, and comes out identical every time. There's no save file yet, so the game persists no player state either.

**In memory while playing** (JS objects, so each record costs far more than its raw numbers):

| What | Count | Memory |
|---|---|---|
| One star record (position, seed, name, star type) | — | ≈ 1.5 KB |
| Sky: every system within 100 ly (`SKY_RADIUS`) | ≈ 6,400 | ≈ 9.5 MB, generated in ~10 ms |
| Jump candidates within 25 ly | ≈ 100 | ≈ 150 KB |
| Current system, fully built (star, ~14 bodies, ~2.6 stations, orbits, palettes) | 1 | ≈ 23 KB, built in ~0.05 ms |
| Sector cache ceiling (`MAX_CACHED` = 40,000 sectors ≈ 61,000 stars) | — | up to ≈ 90 MB before it's cleared |
| GPU: sky point buffer (7 floats per star) | ≈ 6,400 | ≈ 180 KB |

**For scale:** at the current density (about 0.0015 systems per ly³), a sphere 1,000 ly across holds about 800,000 systems. Stored as records that would be about 1.2 GB, but since it's generated there's nothing to store. A real Milky Way (§3) would be about 10¹¹ stars, which only works because of this approach.

**Worth tightening:** the sector cache ceiling is generous. One sky query touches about 9,300 sectors, and regenerating one costs only ~10 ms, so capping the cache at ~12,000 sectors would bound memory near 25 MB with no visible cost.
