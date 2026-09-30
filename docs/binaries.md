# Binary stars

Most stars have a companion, and so do many of Farlight's systems. The design is in `docs/superpowers/specs/2026-09-30-binary-stars-design.md` (SPACE-71).

## Generation (`universe/binary.ts`, `universe/system.ts`)

- **Whether a system is a pair** depends on the primary's class, roughly as observed. Heavier stars have companions more often:

  | Primary | M | K | G | F | A/B |
  |---|---|---|---|---|---|
  | Share of pairs | 25 % | 40 % | 45 % | 50 % | 65 % |

- **The companion's own RNG stream.** The companion is drawn from its own random stream (`seed ^ 0x5bd1e995`), after the system's name and star. A system without one is exactly as it was before pairs existed.
- **Its mass** is a uniform share (0.1–1) of the primary's. Its luminosity, radius, temperature and class follow from the mass on the main sequence (`stars.ts starFromMass`).
- **Close pairs (35 %).** 0.03–0.4 AU apart, e < 0.1, kept apart by at least 4 × their radii together.
  - Their planets orbit **both** stars, from 3.5 separations out; closer in, orbits are unstable (Holman & Wiegert).
  - Planet temperatures and the snow line use both stars' light.
- **Wide pairs.** 20–400 AU apart, e < 0.4.
  - **Each star has its own planets**, within 0.3 of the pair's closest approach.
  - The companion's planets are named `<System> B n`.
  - Separations in between mostly have few planets in reality, so none are made.
- **Star names.** The stars are `<System> A` and `<System> B`. The system keeps its name, and the HUD shows `G4 V + K3 V`.
- **Venydes** is a close pair: its G star with an orange K3 companion 0.15 AU away, circling every ~16 days. From the home world (`Venydes 2`; it was `Venydes 5` before the pair), the suns are up to ~5° apart, so they rise and set about 20 minutes apart.

## Orbits (`sim/barycentre.ts`)

- **Both stars orbit their barycentre**, as real pairs do. It sits at the system's origin, at rest, where a lone star sits. Each star's orbit is the relative ellipse scaled by the other's share of the mass, on opposite sides, at the same rate (`pairOrbits`). `updateBodies` moves them like any orbit.
- **The barycentre is a star-kind point.** It has no size and no light, is the stars' `parent` (and a close pair's planets' parent), and is the system's `anchor`: the default frame and the arrival reference.
- **It is not in `cur.bodies`,** so nothing draws, labels or collides with it. Saves resolve its name, which is the system's.

## Gravity (`sim/gravity.ts`)

- **Close pairs.** Outside the planets' SOIs, the ship is in the barycentre's frame and feels **both** stars, summed. Planets and moons work as before.
- **Wide pairs.** Patched conics, as before, with one more level: each star rules within its Roche lobe (Eggleton's formula, from the pair's closest approach), and the barycentre rules beyond both, with the pair's whole mass.

## Arriving, saves

- **Arriving.** You drop into a close pair at its combined light's `ARRIVE_FLUX`, at least 3 separations from the barycentre. In a wide pair, you drop in at the primary.
- **Old saves.** A save in a system that has changed since, typically one that's now a pair, may name a body or station that no longer exists. In that case the ship arrives afresh ("Venydes has changed since your save") instead of the game starting over.

## Seen from afar

- **The sky and the jump transit** draw a pair as one point: both stars' light, its colour weighted by each star's share (`pairLight`).
- **Up close, each star has its own disc and glow** (`gpu/worlds.ts`), and its own lens flare (`tonemap.wgsl flare`).

## Two suns' light (`sim/starlight.ts sunsAt`)

- **A main light and a second one.** Everywhere, the brighter sun at that place is the main light. In a wide pair, that's a planet's own star. It is lit exactly as a lone star always was: white, full strength, with the exposure and the air tuned for it.
- **The second light's colour and strength.** It's tinted by its colour against the main light's, each at unit luminance, so a K star beside a G one is orange. It's scaled by its flux against the main light's (`c2`).
- **Where each shader gets it:**
  - Worlds (`world.wgsl light2`, `lightL2`, `sunC2`, `lightC2`).
  - Ships (`fx.wgsl`).
  - Stations (`Obj.v[14]`, `v[15]`).
  - Ring discs and rocks.
- **What it lights.** It has its own diffuse and specular on planets, terrain and ring rocks, and its own scattering in the sky, on the flat cloud deck and in the volumetric clouds (a 3-step march toward it). It lights ships, stations and sky stations. Night (the dark side's city lights, its ambient glow) is where both suns are down, a weak one counting for less.
- **Exposure** divides by 1 + the second sun's strength at the camera. The eye takes both as one day's light, as from a lone star of the same total: a close pair's planets are placed for their combined light, so the scene isn't brighter for it.
- **Shadows.**
  - Eclipses of the second sun on worlds, the sky and the clouds (`shadow.wgsl eclipse2`, `sunShade2`). The same bodies are tested as for the first.
  - Mountains' shadows from it, baked per terrain chunk (`terrainBake.wgsl`, the bake's `w`).
  - A second set of shadow cascades (`gpu/shadowmap.ts`, layers 3–5, `frame.wgsl shadowAt2`) for ships, stations, sky stations, ring rocks and the ground near you. They're drawn only while the second sun's light at the camera is over 1 % of the first's. A wide pair's far companion by day isn't worth the passes; the side lit by it at night is.
- **Cost.** In a binary, the air's scattering, the clouds' sun march and the extra cascades roughly double. Single-star systems cost what they did.
- **Not yet from the second sun:** the volumetric clouds' god rays, the cirrus, cloud shadows on the ground and on themselves from near objects (`shadowAtPoint`), and the heat particles' light.

## Heat, power and navigation

- **Solar power and hull heating** sum both suns, each with its own eclipse (`sim/resources.ts solarPower` fills `power.suns`). The readouts show a starlight row per star. "In X's shadow" and the panels' angle are about the brightest.
- **Planets' own glow and reflected light** (`thermal.ts`) use both suns' light on them.
- **Sun tracking** turns the panels toward both suns, weighted by their light. The landing lights come on by the higher sun.
- **The system map** draws a pair's orbits round their barycentre. A star's info shows its own class, its partner, the pair's period, and its planets: its own, or the pair's in a close pair.
- **A wide pair's stars are nav destinations** (`sim/navroute.ts`, kind `'sun'`). You orbit them within their Roche lobes. A close pair's stars aren't, since you arrive beside them; orbits round a single star of a close pair aren't offered.
- **Heat damage and death messages** name the brightest sun.
