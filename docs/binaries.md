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
- **Up close, each star has its own disc and glow** (`gpu/worlds.ts`).

## Still to come

- **Light (phase 2).** Everything is lit by the primary only for now. Next, a second full light: surfaces, air, clouds, rings, ships and stations.
- **Shadows (phase 3).** The second light's own shadows and eclipses.
- **Heat, power and maps (phase 4).** Heat and power from both stars. The system map and navigation for the companion.
