# Binary stars — design

Most stars in the Milky Way have a companion. Farlight's systems get one too, in two real kinds:

- **Close pairs (P-type).** Two stars days to weeks apart, with the planets orbiting both from outside (Tatooine).
- **Wide pairs (S-type).** Two stars tens to hundreds of AU apart. Each has its own planets and stations, and the other shines as a second sun.

The generator can reshape systems freely: saves in changed systems get a fallback (below). The start system, Venydes, becomes a close pair.

Decisions taken (2026-09-30; the barycentre model on review):

- Both kinds of pair.
- Existing systems are regenerated freely.
- Venydes is a close G + K pair.
- In a wide pair, the companion gets its own planets.
- Two full lights: both suns have their own shadows and their own light in the air.
- Both stars orbit their shared centre of mass.

## 1. Model

`StarSystem` (galaxy level) gains an optional companion:

```ts
companion?: {
  star: StarInfo;   // class, T, R, L, colour, as the primary's
  a: number;        // separation (AU)
  e: number;        // eccentricity
  close: boolean;   // P-type (planets round both) or S-type (each its own)
}
```

The two stars orbit their shared centre of mass (as real pairs do):

- **The barycentre is fixed.** It sits at the system's origin, at rest: the frame's inertial anchor, where the lone star sits today.
- **Both stars move on it.** Each is on a Kepler orbit round it: the relative orbit (a, e, the combined mass), split by mass. The primary is at −m₂/M of the separation, the companion at +m₁/M. `updateBodies` propagates both, so in a close pair both suns visibly swing round each other.
- **It's a parent, not a body.** The barycentre is a non-drawn object with pos = vel = 0 and μ = G·(m₁ + m₂) (`sim/barycentre.ts`). It is *not* in `cur.bodies`, so the render, label and nav loops never meet it. Only `parent` links and the frame logic see it, as they see a star today.
- **`CurrentSystem` gains the list and the anchor.** `stars: Star[]` (one or two) and `anchor: Body` (the lone star, or the barycentre). `cur.star` stays as the primary (the brighter), so code that means "the main star" keeps working. Code that means "the light" or "the heat" moves to `cur.stars`, and code that means "the system's centre" (arrival, the default frame, maps) moves to `cur.anchor`.
- **A lone star is its own anchor.** In a system with one star, nothing changes.

## 2. Generation (`universe/galaxy.ts`, `stars.ts`, `system.ts`)

**How many systems are pairs.** This goes by the primary's class, roughly as observed:

| Primary | M | K | G | F | A/B |
|---|---|---|---|---|---|
| Share that are pairs | 25 % | 40 % | 45 % | 50 % | 65 % |

**The companion star.**
- Mass ratio q is uniform on 0.1–1. Its class, T, R and L follow from its mass on the main sequence.
- **Separation.** A pair is close with probability 0.35: a = 0.03–0.4 AU, log-uniform, e < 0.1. Otherwise it's wide: a = 20–400 AU, log-uniform, e < 0.4. Real separations between these bins mostly have few planets, so none are generated.

**Planets in close pairs.**
- Planets orbit both stars, with `parent` = the barycentre (combined μ).
- The first orbit is at least 3.5 × the separation. Closer in, orbits are unstable (Holman & Wiegert).
- Temperatures, snow line and the habitable zone use the combined L.

**Planets in wide pairs.**
- Each star gets its own planets, out to 0.3 × the periapsis separation (stable S-type orbits). Each star's own L sets their temperatures.
- The companion's planets are named with its letter, e.g. `Venydes B 2`.
- Each star's `soi` is its Hill radius, e.g. the companion's a·(1−e)·(m₂/3M)^⅓, and the primary's likewise with m₁. (The mass sets how large it is; the primary's is larger.)

**Stations.** Both stars in a wide pair host them, by the same rules as today. In a close pair, stations stay at planets.

**Names.**
- The stars are `<System> A` and `<System> B`.
- The system keeps its own name, and the header shows `G4 V + K3 V`.

**Venydes.**
- The primary is forced to G, as today, with a K companion at a = 0.15 AU, e = 0.03 (a period of about 16 days).
- `findHome` still has to find an Earth-like world for the start, now round the pair.

## 3. Physics

**Close pairs.**
- Outside any planet's SOI, the ship's frame body is the barycentre and it feels **both** stars: `gravityAt` sums them.
- Planet and moon SOIs work as today; the planets' parent is the barycentre.
- The orbit readouts and the system map's predicted path use the barycentre's combined μ. Within 3 separations of the stars, they say the orbit is "perturbed" instead of drawing a conic.

**Wide pairs.**
- Patched conics, unchanged in kind. Each star's SOI is its Hill radius about the barycentre, and its planets nest inside it.
- Outside both SOIs, the barycentre rules, with the combined μ.

**Other physics.**
- Time warp's stability check treats a close pair's stellar region like a planet's: high warp is refused where the summed pull changes quickly.
- The mass lock (`ftl.ts`), corona contact and damage, fuel scooping and refuel skims apply to each star (they already loop over star bodies, or will).

## 4. Light: two full lights

Every place is lit by up to two stars.

**World uniforms.**
- They gain `light2`, `lightL2` and `sunC2`, plus each light's flux (`light.w`, `light2.w`) and colour. `occ` covers the eclipsers for both stars.
- A system with one star sets `light2.w` to 0, and every second-light term drops out.
- Shaders sum over the two lights through a shared `forLights`-style helper, so each shader isn't written twice.

**Where the second light goes:**
- **Surfaces and air.**
  - Planets: diffuse, specular, night side.
  - The atmosphere's inscatter (`atmo.wgsl`, `atmosphere.wgsl`): summed per light.
  - Terrain: the baked sun shadow gets a second channel (`terrainBake.wgsl`), re-baked when either sun moves.
- **Clouds.**
  - The flat cloud layer.
  - The volumetric clouds: a second sun march with fewer steps, plus god rays from each light.
  - Cloud shadows on the ground.
- **Rings.** Ring disc and rocks: lighting, plus the planet's shadow on the ring for each light.
- **Ships, stations and effects.**
  - Stations, sky stations, ships and particles.
- **Shadows.**
  - A second set of cascades, drawn only while the second light is over 1 % of the first at the camera. A wide companion by day is far under that, but the lit side facing it at night is over it.
  - `eclipse`, `sunShade` and `sunFraction`: per star.
- **Stars themselves.**
  - Each star has its own disc and glow render object, and its own lens flare, dimmed when it's occluded.
  - Bloom takes both as it comes.

**Cost.** In a binary, the atmosphere, the clouds' sun march and the extra shadow cascades roughly double. Single-star systems cost what they do now. The plan checks the GPU time in Venydes against today's, and trims the second light's sample counts first if needed.

## 5. Heat, power and ship systems

**Heat and power.**
- `solarPower`, the starlight in `thermal.ts` and the influence readouts all sum both stars, each with its own eclipse share.
- The HUD's heat rows list the two stars separately.

**Sun tracking.** It points the panels at the flux-weighted direction of the two stars.

**Death messages.** They name the star that did it.

## 6. HUD, maps and navigation

**Header.** It reads `G4 V + K3 V` and shows the combined luminosity. The info panel describes both stars and the pair's orbit.

**Galaxy map and sky.** A pair is one point, with the combined L and a flux-weighted colour. Its label shows both classes.

**System map.**
- It shows both stars and the companion's orbit.
- In a wide pair, the companion's planets are grouped under it.
- The companion is a destination: nav routes, guide and approach warnings.

**FTL arrival.**
- A close pair: at `ARRIVE_FLUX` of the combined light, from the barycentre, facing it.
- A wide pair: at the primary, as today. Reaching the companion is an in-system flight.

## 7. Saves

A save stores the system id and names bodies. If the regenerated system no longer has the body the save refers to (its station, a wreck's reference), the game places the ship at the system's arrival point and drops the orphaned wreck. The save format itself doesn't change.

## 8. Testing

Unit tests (vitest):
- **Generation.**
  - The pair fractions per class, within tolerance over a large sample.
  - A close pair's planets are all beyond 3.5 × a.
  - A wide pair's planets are within 0.3 × a(1−e) of their star.
  - Names are unique.
  - Venydes is a close G + K pair with an Earth-like start world.
- **Physics.**
  - Both stars' orbits about the barycentre: the period matches the combined mass, and the barycentre stays at the origin (m₁r₁ + m₂r₂ = 0).
  - `gravityAt` in a close pair equals the two stars' sum, and SOI nesting holds in a wide pair.
- **Lighting and heat.** Two stars' flux adds, with each star's eclipse applied separately.

In the browser:
- Venydes from its start world: two suns in the sky, double sunsets, both lights on the terrain, clouds and ships.
- A wide pair seen from a planet of each star.
- GPU time against today's.

## 9. Order of work

1. Model, generation, physics, HUD text and saves. Lit by the primary only, so the game stays playable.
2. The second light in the world uniforms and the main shaders: planets, air, clouds and the second star's render.
3. The second light's shadows: cascades, terrain bake, eclipses, rings.
4. Heat and power, then maps and navigation.
5. Docs: a new `docs/binaries.md`, plus updates to `clouds.md`, `post.md`, `terrain.md` and `rings.md`.
