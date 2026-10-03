# Lagrange points

Each planet has five Lagrange points on its orbit round its parent (`sim/lagrange.ts`). They show on the system map (Shift+O) as diamonds labelled "Planet L1"…"L5": hollow where unstable, filled where stable. They only appear for planets you've identified, and L1 and L2 are hidden while they'd sit on top of their planet.

## Why they're analytic

Gravity is patched conics (`sim/gravity.ts`): one body pulls at a time, so the balance of two pulls that makes a Lagrange point can't come out of the physics. Each point is instead a place on rails, worked out from the planet's present position and velocity. In the frame turning with the planet all five sit still, so each is a rigid rotation of the planet's position about the parent, moving at ω × position with ω = r × v / r².

| Point | Where | Stability |
|---|---|---|
| L1 | between the two, r (1 − ρ) | unstable |
| L2 | beyond the planet, r (1 + ρ) | unstable |
| L3 | opposite the planet, −r (1 + 5q/12) | unstable, very slowly |
| L4 | 60° ahead on the planet's orbit | stable |
| L5 | 60° behind | stable |

q is the planet's mass over its parent's, and ρ = (q / 3)^⅓ (the Hill radius over the orbit's radius). These are the small-q forms, good to well under 1 % for planets here (q ≤ 1e-3). L4 and L5 are stable only above the Routh mass ratio of 24.96 (`trojansStable`); every planet and moon clears it.

## Station-keeping

`LPoint.dvYear` is what holding an unstable point costs, in m/s a year: `0.01 · n · d` per orbit, d being the distance from the planet to the point (for L3, √q × the orbit's radius), calibrated on JWST at the Sun–Earth L2 (~3 m/s a year). `driftTime` is the e-folding time of the drift away: 2.07 × the planet's mean motion for L1 and L2 (about 28 days at Earth), far slower for L3. A ship at L4 or L5 costs nothing. Both are planning numbers for now: nothing charges the ship yet.

## Not done yet

- **Targeting and hold.** The points aren't a `Target` and the orbit planner has no "hold at L-point". Holding relative to a planet with the autopilot would burn km/s a year, because the patched-conics ship feels only the star's pull while a real one at L1 is balanced by the planet's. Doing it properly means adding the planet's pull inside its Hill sphere but outside its sphere of influence, or pinning a held ship to the point and charging the Δv above.
- **Trojan fields, parked stations, low-energy transfers.** Steps 2 and 3 of the plan.
- **Moons.** `lagrangePoints` works for any world, but only planets are drawn: a moon's points sit well inside its parent's sphere of influence and need their own handling.

Tests: `src/game/__tests__/lagrange.test.ts`.
