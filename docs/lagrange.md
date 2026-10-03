# Lagrange points and third-body gravity

Each planet has five Lagrange points on its orbit round its parent (`sim/lagrange.ts`). They show on the system map (Shift+O) as diamonds labelled "Planet L1"…"L5" (hollow where unstable, filled where stable) for planets you've identified, and the orbit planner (O, then 6) can hold the ship at one.

## Gravity: patched conics plus third bodies

Gravity is still patched conics (`sim/gravity.ts`): the pull is the innermost sphere of influence's body's, and the ship's velocity is kept relative to it. A balance of two pulls can't come out of that alone, so it now has two corrections on top, which are what make the points real:

- **In a star's frame, each planet's own pull**, in full out to 3 Hill radii and tapering to nothing by 6. The taper is radial, so the force stays conservative (no energy gained or lost by flying round).
- **In a planet's (or moon's) frame, its parent's tide**: the parent's pull on the ship less its pull on the frame body (which the carried frame already supplies), fading in over the outer 30 % of the SOI. Deep inside an SOI it's zero, so orbits there stay exact Kepler orbits and time warp's rails stay valid.

At the SOI's edge the two are the same acceleration, so crossing the boundary no longer jolts the ship (the old switch jumped by about the planet's whole pull). `Gravity.vec` includes the corrections; `Gravity.g` is the body's own pull. Time warp's rails (`sim/timewarp.ts`) include them too.

## The points

In the frame turning with the planet all five sit still, so each is a rigid rotation of the planet's parent-relative position, moving at ω × position (ω = r × v / r²) with acceleration −ω² × position.

| Point | Where | In the sim |
|---|---|---|
| L1 | between the two, about a Hill radius short of the planet | unstable (e-fold ≈ 0.5 / n: ~3 weeks at Earth) |
| L2 | beyond the planet, a Hill radius farther | unstable, the same |
| L3 | opposite the planet, at its orbit's radius | free circular orbit |
| L4 | 60° ahead | free circular orbit, stable |
| L5 | 60° behind | free circular orbit, stable |

L1 and L2 are **solved against the force the ship feels** (Newton on the parent's pull plus the planet's tapered pull plus the centripetal term), so a ship there at the point's velocity needs no thrust, and the instability is real: left alone it leaves. L3, L4 and L5 are 14+ Hill radii from the planet, where the taper has removed its pull, so each is simply a circular orbit with the planet's radius and period. In reality the planet's faint pull makes L4 and L5 librate over thousands of years and L3 drift over decades; neither shows in a game session. L4 and L5 are stable only above the Routh mass ratio of 24.96 (`trojansStable`), which every planet and moon here clears.

For a planet on an eccentric orbit (up to e = 0.06 here) the points follow the planet's *instantaneous* angular rate, so they sway a little as it speeds up and slows down, and a held ship pays for keeping up.

## Holding at a point (orbit planner, key 6; HX-8200 and up)

Planner → 6 (L-point) → R steps L1…L5 → Enter. The planner shows the point, its distance from the planet, and whether it is stable. The autopilot flies there (an FTL leg if it's far, dropping at rest relative to the planet), matches the point's velocity, and holds, feeding forward the point's centripetal acceleration less the ship's own gravity (which near L1/L2 is nearly all of it). The autopilot panel and maneuver guide show the offset, the drift and the propellant burned.

Measured in the tests (`lagrangeHold.test.ts`): once settled, holding L4 costs a few m/s a year and L1 well under 50 m/s a year; with the planet's pull left out of the force it would be thousands. `LPoint.dvYear` is a separate planning estimate of what real station-keeping costs (`0.01 · n · d` per orbit, calibrated on JWST at Sun–Earth L2, ~3 m/s a year), shown in the planner for the unstable points; the sim charges whatever the autopilot actually burns.

Time warp is refused while the autopilot holds (it works on thrust), like any hold.

## Not done yet

- **Arriving cheaply.** The autopilot matches the point's velocity at once, which is cheap for L1 and L2 (a few hundred m/s from rest relative to the planet) but not for L3–L5 (about the planet's orbital speed, ~30 km/s at Earth). A real trip drifts there by a small change of orbit over months; a phasing transfer would do the same.
- **Targeting.** The points aren't a `Target` (no T/G/click, no approach strip).
- **Trojan fields, parked stations, low-energy transfers.** Steps 2 and 3 of the plan.
- **Moons.** `lagrangePoints` works for any world, but only planets are drawn and held. A moon's points would sit inside its parent's sphere of influence and need the tide there.
- **Close pairs.** Near L-points of a planet round a close binary's barycentre the parent's pull is taken as one point mass.

Tests: `src/game/__tests__/lagrange.test.ts` (geometry, equilibrium against `gravityAt`, a ship kept with L4 for two years and with L1 for days, L1's drift, SOI continuity) and `lagrangeHold.test.ts` (the autopilot's hold).
