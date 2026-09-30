# Binary stars, phase 1: model, generation, orbits, gravity, HUD text

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Systems can be close or wide star pairs, with both stars orbiting their barycentre. Planets, gravity, arrival, saves and HUD text follow. The game stays playable and is still lit by the primary; the second light comes in phase 2.

**Architecture:**
- A companion is generated per system at the galaxy level (`StarSystem.companion`), from its own RNG stream, so systems without one don't change at all.
- `buildSystem` makes both stars `Star` bodies on Kepler orbits round a barycentre. The barycentre is a `Star`-kind object at the origin (`bary: true`, radius 0, L 0). It is kept out of `bodies` and serves as the close pair's planet parent and as the frame anchor.
- `CurrentSystem` gains `stars` and `anchor`. In a close pair, gravity sums both stars outside planet SOIs. In a wide pair, it's patched conics with Roche-lobe SOIs.

**Tech Stack:** TypeScript, three.js maths, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-30-binary-stars-design.md`.
- Pair share by primary class: M 25 %, K 40 %, G 45 %, F 50 %, A/B 65 %.
- Close pairs: probability 0.35, a = 0.03–0.4 AU log-uniform, e < 0.1. Their planets start at ≥ 3.5 × a.
- Wide pairs: a = 20–400 AU log-uniform, e < 0.4. Their planets stay within 0.3 × a(1−e) of their star.
- Mass ratio q is uniform on 0.1–1. The companion's L = m^3.5 (as `system.ts`' primary mass), R = m^0.8 (m < 1) or m^0.57, and T from L and R.
- Names: `<Sys> A`, `<Sys> B`. The companion's planets are `<Sys> B n`; the primary's keep `<Sys> n`.
- Venydes: a G primary (unchanged draw) with a K companion at a = 0.15 AU, e = 0.03, close.
- Checks: `npx tsc -b && npx eslint src && npx vitest run`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and mention SPACE-71.

---

### Task 1: The companion at galaxy level

**Files:**
- Create: `src/game/universe/binary.ts`
- Modify:
  - `src/game/types.ts` (`Companion`, `StarSystem.companion`)
  - `src/game/universe/stars.ts` (export `CLASSES`, add `starFromMass`)
  - `src/game/universe/galaxy.ts` (sectors and home)
- Test: `src/game/__tests__/binary.test.ts`

**Interfaces:**
- Produces:
  - `interface Companion { star: StarInfo; a: number /* AU */; e: number; close: boolean }`
  - `starMass(L: number): number` (solar masses)
  - `makeCompanion(primary: StarInfo, seed: number): Companion | undefined`
  - `homeCompanion(primary: StarInfo): Companion`
  - `pairSpec(sys: StarSystem): string` (`'G4 V + K3 V'`, or the lone spec)
  - `starFromMass(m: number, g: Rng): StarInfo`

- [ ] Step 1: Write the tests.
  - Over 20,000 random primaries per class, the pair share is within ±3 % of the table.
  - The close share is 0.35 ± 0.03.
  - Every close a is in [0.03, 0.4] with e < 0.1; every wide a is in [20, 400] with e < 0.4.
  - The companion's mass is at most the primary's.
  - `homeSystem().companion` is close, with a = 0.15 and cls K.
  - `pairSpec` joins both specs with `' + '`.
- [ ] Step 2: Implement `starFromMass`. It computes L, R and T as in the Global Constraints, finds the class whose T range holds T (clamped to M/B), and sets the subclass by position in the range as `makeStar` does.
- [ ] Step 3: Implement `makeCompanion`.
  - Draw from `mulberry32(seed ^ 0x5bd1e995)`: the pair roll, then q, close/wide, a and e.
  - The companion mass is `max(0.08, q·m₁)`.
- [ ] Step 4: Wire it into the galaxy.
  - `generateSector`: `companion: makeCompanion(star, seed)`.
  - `makeHome`: `companion: homeCompanion(star)` before the seed search. `homeCompanion` picks the mass that gives a K3-ish star (T ≈ 4800 K), with a = 0.15 and e = 0.03.
- [ ] Step 5: Run the tests (they pass), then `npx tsc -b`, then commit.

### Task 2: Stars round a barycentre, and planets by pair type

**Files:**
- Create: `src/game/sim/barycentre.ts`
- Modify:
  - `src/game/types.ts` (`Star.orb?`, `Star.parent?`, `Star.bary?`)
  - `src/game/universe/system.ts` (split the planet loop into `addPlanets`; the pair branch)
  - `src/game/sim/kepler.ts` (`updateBodies` propagates stars that have an orbit)
- Test: `src/game/__tests__/binary.test.ts`

**Interfaces:**
- Consumes: `Companion`, `starMass`.
- Produces:
  - `makeBarycentre(name: string, mass: number): Star` (bary: true, radius 0, L 0, soi ∞)
  - `pairOrbits(a: number /* m */, e: number, m1: number, m2: number, seed: number): [KeplerOrbit, KeplerOrbit]`. Same n and M0; P and Q negated for B; semi-major axes a·m₂/M and a·m₁/M.
  - `rocheLobe(q: number): number` (Eggleton: 0.49q^⅔ / (0.6q^⅔ + ln(1 + q^⅓)))
  - `systemAnchor(bodies: Body[]): Body` (the lone star, or `bodies[0].parent`, the barycentre)
  - `buildSystem` returns `[A, B, planets…]` for pairs and `[star, planets…]` otherwise.

- [ ] Step 1: Write the tests.
  - For a pair system: m₁r₁ + m₂r₂ ≈ 0 at several t, and the separation stays within a(1 ± e).
  - The period is 2π√(a³/GM).
  - Close pair: all planets have `parent` = the barycentre and orbit ≥ 3.5a.
  - Wide pair: B's planets have `parent` B and orbit ≤ 0.3a(1−e); A's likewise.
  - The names are unique.
  - `findHome(buildSystem(homeSystem()))` is found.
  - A system without a companion builds exactly as before (body names and orbits are equal to a snapshot taken before the change).
- [ ] Step 2: Implement `barycentre.ts` and move the planet loop into `addPlanets(bodies, g, { parent, L, prefix, aMin, aMax })`. The single-star path calls it with today's values, so it's unchanged.
- [ ] Step 3: Implement the pair branch.
  - Close: `addPlanets` with parent = the barycentre, L = L₁ + L₂, aMin = max(today's first orbit, 3.5a).
  - Wide: `addPlanets` for A (prefix `sys.name`, aMax = 0.3a(1−e)), then for B (prefix `sys.name + ' B'`, the same aMax, its own L).
  - Star SOIs: a close pair's stars get soi 0 (their gravity is summed in Task 3). A wide pair's stars get a(1−e)·rocheLobe(m_self/m_other).
- [ ] Step 4: Make `updateBodies` call `keplerState` for any body with `orb` (stars included), before the planets.
- [ ] Step 5: Run the tests (they pass), then commit.

### Task 3: The system's anchor, gravity and the frame

**Files:**
- Modify:
  - `src/game/types.ts` (`CurrentSystem.stars`, `anchor`, `close`)
  - `src/game/Game.ts` (`loadSystem`)
  - `src/game/sim/gravity.ts` (`dominantBody`, `gravityAt`)
  - `src/game/sim/navigation.ts` (`arriveAt`, `placeAtHome`)
  - `src/game/sim/traffic.ts` (frame body)
  - `src/game/save.ts` (the finder resolves the anchor's name; fallback on a missing name)
- Test: `src/game/__tests__/binary.test.ts`

- [ ] Step 1: Write the tests.
  - Close pair: `gravityAt` at a point 2 AU off equals the vector sum of both stars' pulls, and `dominantBody` is the anchor.
  - Wide pair: a point inside B's SOI (but outside its planets') has B as its dominant body; a point outside both has the anchor.
- [ ] Step 2: Implement.
  - `loadSystem`: `stars = bodies.filter(star)`, `anchor = systemAnchor(bodies)`, `close = !!sys.companion?.close`, `frameBody = anchor`.
  - `dominantBody`: start at the anchor, then take a wide pair's star if inside its SOI, then planets and moons as today.
  - `gravityAt`: if `cur.close` and the body is the anchor, sum the stars.
- [ ] Step 3: Update arrival and saves.
  - `arriveAt`: a close pair arrives from the anchor at the combined L, a wide pair at the primary.
  - Saves: the finder's `body(n)` also matches `cur.anchor`. `restore` catches a missing-name error from `restoreFlight` and falls back to `arriveAt(g, sys)` with the message "System changed since your save · arrived at X".
- [ ] Step 4: Run the full checks, then commit.

### Task 4: HUD, map and message text, and drawing both stars

**Files:**
- Modify:
  - `src/game/hud/snapshot.ts` (header and jump line)
  - `src/game/render/Overlay.ts:895`
  - `src/game/sim/navroute.ts:172,318`
  - `src/game/sim/guide.ts:209`
  - `src/game/sim/update.ts:371`
  - `src/game/gpu/worlds.ts` (a star render per star)
  - `src/game/gpu/sky.ts`, `hyperspace.ts` (a pair's point: combined L, flux-weighted colour)

- [ ] Step 1: Use `pairSpec(sys)` wherever a system's spec is shown.
  - The header: `G4 V + K3 V · L 1.43 L☉ · 5654 / 4800 K`.
- [ ] Step 2: Replace `worlds.ts`' single `this.star` with `this.stars: StarR[]`, one disc and glow each. Lighting still uses `cur.star`, until phase 2.
- [ ] Step 3: `sky.ts` and `hyperspace.ts`: a pair's point uses L₁ + L₂, and the colour lerped by L share.
- [ ] Step 4: Browser check.
  - Venydes: two suns visible from the home world, and the companion moves over minutes of time warp.
  - A wide pair: the companion is visible, and its planets exist.
- [ ] Step 5: Run the full checks, then commit.
- [ ] Step 6: Docs. Write `docs/binaries.md` covering generation, orbits and gravity, and what phase 2 adds.
