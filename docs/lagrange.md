# Lagrange points and third-body gravity

Each planet has five Lagrange points on its orbit round its parent (`sim/lagrange.ts`). They show on the system map (Shift+O) as diamonds labelled "Planet L1"…"L5" (hollow where unstable, filled where stable) for planets you've identified, and the orbit planner (O, then 6) can hold the ship at one.

## Gravity: patched conics plus third bodies

Gravity is still patched conics (`sim/gravity.ts`): the pull is the innermost sphere of influence's body's, and the ship's velocity is kept relative to it. A balance of two pulls can't come out of that alone, so it now has two corrections on top, which are what make the points real:

- **In a star's frame, each planet's own pull**, in full out to 3 Hill radii and tapering to nothing by 6. The taper is radial, so the force stays conservative (no energy gained or lost by flying round).
- **In a planet's (or moon's) frame, its parent's tide**: the parent's pull on the ship less its pull on the frame body (which the carried frame already supplies), fading in over the outer 30 % of the SOI. Deep inside an SOI it's zero, so orbits there stay exact Kepler orbits and time warp's rails stay valid.

At the SOI's edge the two are the same acceleration, so crossing the boundary no longer jolts the ship (the old switch jumped by about the planet's whole pull). `Gravity.vec` includes the corrections; `Gravity.g` is the body's own pull. Time warp's rails (`sim/timewarp.ts`) include them too.

## The points

L1 and L2 sit still in the frame turning with the planet, at its instantaneous angular rate (ω = r × v / r²): velocity ω × position, acceleration −ω² × position. L3, L4 and L5 are free orbits (below).

| Point | Where | In the sim |
|---|---|---|
| L1 | between the two, about a Hill radius short of the planet | unstable (e-fold 1 / (2.53 n): 23 days at Earth) |
| L2 | beyond the planet, a Hill radius farther | unstable, the same |
| L3 | opposite the planet | free orbit |
| L4 | 60° ahead | free orbit, stable |
| L5 | 60° behind | free orbit, stable |

L1 and L2 are **solved against the force the ship feels** (Newton on the parent's pull plus the planet's tapered pull plus the centripetal term), so a ship there at the point's velocity needs no thrust, and the instability is real: left alone it leaves. For a planet on an eccentric orbit (up to e = 0.06 here) they follow its instantaneous angular rate, so they sway a little as it speeds up and slows down, and a held ship pays for keeping up.

L3, L4 and L5 are 14+ Hill radii from the planet, where the taper has removed its pull, so each is a **free Kepler orbit with the planet's period**: the planet's own orbit with its mean anomaly shifted by 180°, +60° or −60° (`trojanRel`). That is exact however eccentric the orbit, and a ship there needs no thrust. (In reality the planet's faint pull makes L4 and L5 librate over thousands of years and L3 drift over decades; neither shows in a game session.) L4 and L5 are stable only above the Routh mass ratio of 24.96 (`trojansStable`), which every planet and moon here clears.

## Holding at a point (orbit planner, key 6; HX-8200 and up)

Planner → 6 (L-point) → **R** steps L1…L5 → **[ ]** sets the orbits to phase over (L3–L5) → Enter. The planner shows the point, how it gets there (TRANSFER), and the cost. Holding feeds forward the point's acceleration less the ship's own gravity (which near L1 and L2 is nearly all of it), so it costs next to nothing; the autopilot panel and maneuver guide show the offset, the drift and the propellant burned.

**L1 and L2** are flown to directly (an FTL leg, dropping at rest relative to the planet, then a few hundred m/s to match the point).

**L3, L4 and L5: the phasing transfer** (`sim/phasing.ts`). Matching one of these at once means matching about the planet's orbital speed (~40 km/s at 0.9 AU), so the autopilot does what a real mission does: change your orbital period a little, drift round, change it back.

1. **To the departure gate.** An FTL leg (or thrusters, if close) to `gatePoint`: a free point on the planet's own orbit, 7+ Hill radii ahead of it (behind it, for L5), outside its pull. The drive drops out matched to it, the way it does beside a station.
2. **The burn.** From the gate the plan is exact: the phasing orbit passes through the gate, you come back to it after N turns, and the point has moved to meet you there. The flight takes T = (N + the phase to cover) planet periods; the speed on the new orbit follows from vis-viva. The burn is flown at the autopilot's thrust (an instant, at 1,200 m/s²).
3. **The coast.** No thrust; **time warp works** (the one autopilot state that allows it). At up to ×100,000 a three-orbit trip at Earth takes about 15 minutes. Warp is held short of the next event so it comes at ×1, and the warp you had is put back after it.
4. **Mid-course corrections.** At 15, 40, 70, 90, 97 and 99.5 % of the flight the autopilot re-solves from where the ship actually is (a Newton shooting solver on a Kepler propagator) and burns the difference if it's over 2 mm/s. They are tiny, because the plan has no gravity to leave out beyond the parent's.
5. **Arrival.** The hold takes over at the planned time, a few km from the point, with the planned closing speed, and closes gently (2 m/s², 300 m/s at most) rather than at its usual far-approach profile.

The cost falls with N: about v / (9N) in all for a 60° lead from the gate. Measured through the autopilot (`lagrangeHold.test.ts`, with a planet at 0.93 AU):

| To | Orbits | Time | Δv in all |
|---|---|---|---|
| L4 | 3 | 2.0 yr | 1.7 km/s |
| L5 | 4 | 2.9 yr | 1.5 km/s |
| L3 | 4 | 2.5 yr | 4.2 km/s |

against ~40 km/s going straight there. `[ ]` in the planner sets N from 1 to 40 (Shift: five at a time; 0: straight there). The long end is the low-energy transfer: the cost keeps falling as 1 / N, so a few dozen orbits (decades at Earth, minutes under time warp) take a few tens of m/s; the planner labels a plan under 300 m/s "low-energy"; it shows the time and Δv, and refuses a transfer the tanks can't pay for (plus a margin). The default is 3.

Holding costs, once settled: L4 a few m/s a year (the step size's own error), L1 well under 50 m/s a year; with the planet's pull left out of the force it would be thousands. `LPoint.dvYear` is a separate planning estimate of real station-keeping (`0.01 · n · d` per orbit, calibrated on JWST at Sun–Earth L2, ~3 m/s a year); the sim charges whatever the autopilot actually burns.

Time warp is refused while the autopilot holds (it works on thrust), like any hold, and during a phasing burn, but not during its coast.

## Targeting the points (`sim/lpoints.ts`)

The points of every planet the radar has found are targets (`LTarget`, kind `lpoint`; they're worked out from the planet each step, since they're on rails, but each keeps its identity so `g.target` stays equal to itself):

- **T** aims at one (a marker is picked up to 0.35 rad off the nose), **G** cycles them with the bodies and stations by distance, and a click on its marker picks it; on the system map (Shift+O) a click on a point's diamond targets it.
- **Marker:** a cyan diamond (hollow at L1–L3, filled at the stable L4 and L5) with name and distance, within 2·10¹⁰ m of you and always for the target (with an edge arrow when it's off screen).
- **Target card and info (I):** where it is, what a ship left there does (stays, or drifts away in so many days, with the real-mission station-keeping figure), the swarm round it and its extent, any depot, and your distance and relative speed.
- **Approach strip:** where the planet's gravity takes over, and at L4 and L5 the swarm's core.
- **O** with a point targeted opens the orbit planner already set to hold there (L-point, that point); the hold, the phasing and the rest are as above.
- Saved and restored by name.

## Routes to the points (nav computer, M)

A Lagrange point is a destination like a body or a station (`sim/navroute.ts`):

- **Adding one.** Target a point (T, G, click) and open the nav panel, or search: type a planet's name and L (`Venydes 2 L`) or a point's full name (`Venydes 2 L4`). In this system the search offers the points of planets the radar has found; in other systems (within jump range, or one whose name the query starts with) every planet's five. A point is the route's last stop, like a body or station: choosing one in another system makes that system the last waypoint, and the plan is the jumps, then the point.
- **The leg** (`Hold at Venydes 2 L4`): the nav computer waits for the battery, then hands the ship to the autopilot as a hold at the point: straight there for L1 and L2 (an FTL leg, then the match), a **phasing transfer** for L3–L5 (three orbits by default) (to the departure gate, the burn, the coast, the match). The panel gives the leg's time (about ten minutes, or for a transfer to L4 a couple of years of sim time); the route status follows the transfer (`flying to the departure point`, `phasing burn`, `coasting · 1.4 years to go · time warp works`, `matching`). **Time warp is allowed while a route coasts** through a phasing transfer, and not otherwise (as for any route). The leg ends, and the route with it, when the hold is made; the autopilot goes on holding.
- **Refused** (the route ends with the reason): no orbit computer that holds at points (an HX-6100), or not enough Δv for the transfer (the same check as the planner's).
- **The orbit count** is set in the nav panel (− / + buttons, or `[` and `]`, Shift for five; 0 to 40, default 3, saved with the game). The panel gives that choice's time and Δv: more orbits cost less and take longer (about 1.1 km/s over three orbits to L4 at Earth, 0.3 km/s over a dozen), and 0 flies straight there. It is locked while a route is flying.

## The saddle at L1 and L2 (`sim/manifold.ts`)

Near L1 or L2 the motion in the planet's turning frame is a saddle × centre: one direction grows as e^{λt} (the **unstable manifold**, where a ship left alone drifts to), one shrinks as e^{−λt} (the **stable** one, the way it falls in), the rest oscillates at ν. `saddleModes(planet, k)` linearises the force the ship feels (the parent's pull plus the planet's, tapered) about the point and solves the in-plane modes, `s⁴ + (4ω² − Kxx − Kyy) s² + (Kxx Kyy − Kxy²) = 0`; the position direction of a mode is (1, (s² − Kxx) / (Kxy + 2ω s)). For a light planet λ = 2.53 n, the textbook 23 days at Earth (my first, hand-derived 2.07 was wrong; the test against a flown ship caught it), and it rises with the planet's mass. `driftTime` (the planner's "drifts away over…", the autopilot panel's) now comes from it. Tests fly a ship started on each manifold under the real force and check it leaves at e^{λt} or falls in.

## Trojan swarms (`sim/swarm.ts`, `universe/trojans.ts`)

Every gas and ice giant has a swarm of rocks round both its L4 and L5 (a rocky planet sometimes a thin one): a loose cloud, thick at its core and gone ~3σ out, wide along the planet's orbit and thin across it (σ along ≈ 0.14–0.22 rad of its orbit, across ≈ 2–4.5 % of its radius, up and down ≈ 1.5–4 %). The core is the point itself, so a ship that holds at L4 is in the middle of it.

- **Generation.** Like the ring's rocks, never stored. Space round the swarm's centre is cut into 4 km cubes (axes fixed in space) and a hash of each decides whether it holds a rock (the chance is the Gaussian density × the swarm's core density, 0.10–0.18 per cube for a giant), where, how big (8–300 m, mostly small) and its tint, from the ring's own random stream. The rocks sit still in the frame that moves with the centre (a free orbit with the planet's period), so they co-move with the point. About 40–100 are within 24 km of a giant's core.
- **What they are.** Dry, dark rock, not ring ice: 0–12 % ice, 8–28 % metal (mostly nickel-iron, a few % cobalt, ~1 % platinum-group), and one in 12 a metal core: 40–65 % metal of three kinds (nickel-iron 50 %, cobalt-rich 30 %, platinum-rich 20 %). That is roughly ten times a ring rock's metal for the same laser time and a fraction of its propellant. The prospect pill and laser readout name them "rocky" or by metal kind.
- **In the swarm** (within 2σ of the core):
  - flight assist works against the swarm (its centre's own velocity, so hands off you hold still among the rocks), with the belt's speed limit of 800 m/s (×3 boosting);
  - the mining laser, the radar's prospecting sweep, and collisions (the ring's rules: lighter than the ship knocked aside, heavier bounces it, damage by closing speed scaled for mass) all read the same rocks the renderer draws;
  - FTL is not locked, as it is among a ring's rocks: the rocks are 6+ km apart.
- **Drawing** (`gpu/swarm.ts`, `gpu/shaders/swarmRock.wgsl`): the CPU lists the rocks within 24 km each frame (the nearest 600; they shrink away over the last fifth of the reach) and the GPU draws each as one lumpy, flat-shaded icosphere: its shape from a value noise on a hashed integer lattice (no texture, so the CPU's laser ray and the GPU agree), squashed and turned by the rock's own draws. The system map (Shift+O) outlines each swarm of a planet you know, at 2σ.
- **Mined rocks** go in the same table as the ring's (`minedRocks`, saved), under keys starting `~`.

## Depots (`sim/depotGeom.ts`, `render/depotMesh.ts`, `gpu/shaders/depot.wgsl`)

A third station model, parked at a Lagrange point. About one giant swarm in five has one, and now and then a habitable world has one at its L4 or L5 (`universe/stations.ts buildDepots`); a few per hundred systems. The model is a **round landing plate** at the +x end of a **truss spine** with 8 pads painted on it and ringed with lamps; at the other end a **tank farm** of eight pale propellant spheres in two rings; two **radiator fins** hanging under the spine, two **solar wings** flat on either side, a **habitat block** with lit windows under the plate, and a strobing **beacon mast**. 900–1,300 m long, its plate ~340–500 m across.

- **Orbit.** It keeps its planet's orbit with the mean anomaly shifted by the point's 60° and a little more (a random spot in the swarm), so it stays put relative to the planet for ever on a free orbit round the planet's parent: `Station.parent` is the planet it keeps company with, `orbitBody(st)` the star. Its attitude is fixed in space (+z along the orbit's normal) and it doesn't spin.
- **Docking** is the sky station's open deck (`isDeck`): target it within 10 km, K for a pad, come down onto the plate from above. No air, no catapult (K lifts off), and no gravity feed-forward for the docking computer: the ship and the depot fall together, as at an orbital station. Pads, contact, the docking computer, the guide, the HUD, the map and the info panel all handle it. The station window (trading, services, contracts, outfitting) is the same.
- **Other ships use depots** like any station: they spawn docked at them, fly out to them (the rendezvous takes the star as its body, `sim/planner.ts engageRendezvous`; the FTL leg drops out matched to the depot, like beside any station), dock on the plate with the docking computer and lift off again. A depot counts as one more station for how many ships a system has.
- **Tested** with the real autopilot and docking computer on a mocked thruster (`lagrangeHold.test.ts`, `depotDock.test.ts`): a ship 300 km off closes on a depot, matches its orbit and settles at the 2 km stand-off; one at the hold point over the plate flies the docking computer's phases down onto pad 1, upright, under 6 m/s. A full NPC captain's loop (spawn, travel, dock, launch) needs the whole `Game` and hasn't been run.

The depot's shader and the swarm's were compiled and test-rendered offscreen (Dawn on software Vulkan) before they were wired in.

## Not done yet

- **Manifold transfers** *through* L1 and L2: **analysed, and not built, because they don't pay here.** A ship leaving L1 or L2 along the unstable manifold costs nothing and drifts away at e^{λt}, but onto a heliocentric orbit that is not the planet's: the point sits ~1 Hill radius off the planet's orbit and moves at the point's rate, so its speed differs from the circular speed there by ~n·d (385 m/s at Venydes 2's L1, ~1 % of the orbital speed), and that eccentric orbit never reaches the radius of L4 or L5. The planner (`planPhasing` from the L1 state) finds no solution near the point's velocity for 3 to 12 orbits, only far branches at tens of km/s; the capture would cost that same few hundred m/s, which long phasing from the gate already beats (about 300 m/s over a dozen orbits at Earth). With FTL to drop out matched at L1 or L2 in the first place, the stable manifold has nothing to save either. The saddle (`sim/manifold.ts`) still drives the drift times and the hold's behaviour.
- **Moons.** `lagrangePoints` works for any world, but only planets are drawn, held and swarmed.
- **Close pairs.** Round a close binary's barycentre the parent's pull is taken as one point mass, in the plan and in the points.
- **The trip from low orbit.** The first leg (out of the planet's mass lock and to the gate) is the usual thruster-then-FTL flight; there's no planned escape burn.
- **L1 and L2 are still direct.** Their match costs a few hundred m/s, so they have no phasing.
- **A dust hazard** (as in a ring's belt) isn't modelled in swarms.

Tests: `lagrange.test.ts`, `phasing.test.ts`, `lagrangeHold.test.ts`, `depot.test.ts` (placement, orbit, attitude, pads and geometry) and `swarm.test.ts` (the fields, the centre, the density, the rocks, mining, the ray, what they're made of).

## Swarm shadows and radar

- **Shadows.** Swarm rocks are casters in the shadow map (`vsShadow` in `swarmRock.wgsl`, the same shape as the draw, into every cascade) and receivers (`shadowAt` on the lit term and the metal glint), so rocks shade each other and other ships and stations; they switch the shadow map on while any are drawn. The pipelines were created and the shader compiled offscreen (Dawn) against the real caster layout.
- **Radar.** A sweep finds every swarm within range (a diffuse return: its edge counts as ~2σ short of the core). It's listed in the radar window as a *trojan swarm* contact whose target is its L4 or L5 point (so T, the nav search and the planner work from it), at the distance to its near edge. Found swarms are remembered per system with the other contacts (`swarm:<id>` scan keys, saved with them).

## Releasing a hold at L1 or L2 (`sim/release.ts`)

From a settled hold at L1 or L2 the autopilot panel (O) offers **[ Release toward planet** and **] Release away** (the keys, or the buttons). It pushes the ship 10 cm/s along the saddle's unstable direction (`saddleModes`, signed toward or away from the planet) and disengages: the drift does the rest, at e^{λt}. The push excites the growing mode with amplitude dv / 2λ, so a Hill radius takes ln(Hill / that) / λ: about a year at Earth's L2, which the panel and the message give. The test flies both branches under the real force, from both points: the planet branch closes on the planet, the away branch leaves along the orbit, and the time to open 0.3 of a Hill radius falls inside the prediction's window. It is not a cheaper way anywhere (see the manifold note above): it is the controlled way to let a hold go, onto a chosen side.

**Keeping clear of the planet.** The planet branch falls into the planet's neighbourhood, so before a release toward it the planner (`safePush`) flies the drift under the real force for three drift times (`releaseHorizon`; the bodies are moved along their rails and put back) and checks how close it comes. At an Earth-like world the plain push passes about 41 radii off (L1) or 100 (L2), nowhere near. If a fat world's first pass would come inside `safeDistance` (its surface and air, with room to spare: at least 20 % of its radius above), the planner tries the same push with a sideways push added out of the orbit's plane, smallest first (sizes from 2 % to 2× clearance × the planet's mean motion: a few m/s to tens), flies each, and takes the first that clears. A big enough sideways push carries the ship off without ever falling in, which is the cost of avoiding the planet. If none clears, the release is **refused** with the closest approach and what it needs, and the ship is left holding. The message after a release says how close the drift will pass and the push made. Release away needs no check.
