# Radiation

The dose rate round the ship, what the hull and the magnetic deflector stop of it, and the crew's accumulated dose (`sim/radiation.ts`, each step after the belt and before the power is settled).

## Outside (mSv/h)

| Source | Kind | Rate |
|---|---|---|
| Cosmic rays | cosmic | 0.075 everywhere (~1.8 mSv/day, as between the planets) |
| A star's wind | particles | 0.02 × its flux (Earth = 1) |
| A star's UV and X-rays | rays | 0.01 × its flux × (T / 5778 K)⁴, none in a body's shadow: a B star's is ~100× a Sun's |
| A giant's radiation belts | particles | 3,000 × √(M / M♃) at the peak (ice giants × 0.05): a shell round its spin (magnetic) equator peaking 2.5 radii out (log-normal, width 0.6), fading toward the poles (× (1 − 0.8 sin² latitude)) |
| The galactic core's disk | rays | 10 × its flux (docs/blackhole.md): 200 where you arrive, 150 AU out |

A world's air shields all of it: what gets through is e^(−8 × the air's column over you, in bar), about 3 × 10⁻⁴ on an Earth's ground. Docked or inside a station, nothing gets in.

## Inside

- **The hull** lets through 10 % of the particles, 70 % of the cosmic rays and 5 % of the rays.
- **A powered magnetic deflector** (MD-4 / MD-8, already fitted against ring dust) turns away its `block` share (90 / 98 %) of the particles and 30 % of that of the cosmic rays. It doesn't stop rays at all.
- **Power:** the deflector switches on by itself when the particles outside pass 0.5 mSv/h. It shares its power with the dust (sim/belt.ts), behind the `shield` breaker.

What that comes to:

| Where | Outside | Inside |
|---|---|---|
| 1 AU from a Sun-like star | 0.105 | ~0.055 (1.3 mSv/day) |
| A Jupiter's belts at their peak | 3,000 | ~300 bare, ~6 with the MD-8 |
| Arriving at the galactic core (150 AU) | 200 | ~10 |
| 20 AU from the core | ~11,000 | ~560 (fatal in ~9 h) |

## The crew's dose

- **It builds up** from the rate inside, and heals by half every 2 days of sim time (time warp helps). At a steady rate it settles at the rate × 2.9 days. Only a rate over ~72 mSv/h inside ever reaches the fatal dose.
- **Limits:** 0.25 Sv elevated, 1 Sv radiation sickness, 3 Sv severe (a warning at each, re-armed 10 % under it). At 5 Sv the crew dies: the ship is lost and you respawn.
- **The medbay** (station window, Services) treats it for 8,000 Cr per Sv, scaled like repairs by the station, as far as your credits go.
- **Saves:** the dose is saved. A respawn starts at 0.

## On the HUD

- **RADIATION gauge** (ship panel): the rate inside, with a bar of the dose toward 5 Sv (banded at the limits). The line under it reads "fatal in …" when the rate would get there, otherwise what's outside.
- **Radiation lamp:** lit over 1 mSv/h inside or 0.25 Sv of dose, blinking when it's fatal within the hour.
- **Influences (B), RADIATION section:** the rate inside, each source, what the air lets through, what the hull and the deflector stop (or that the deflector is off or missing where it would help), and a tip for the biggest source.
- **The black hole's approach scale** marks its disk's edges instead of a corona scoop.
