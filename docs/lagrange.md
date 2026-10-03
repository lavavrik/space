# Lagrange points and third-body gravity

Each planet has five Lagrange points on its orbit round its star, and each moon five on its orbit round its planet (`sim/lagrange.ts`; see "Moons' points" below). A planet's show on the system map (Shift+O) as diamonds labelled "Planet L1"…"L5" (hollow where unstable, filled where stable) for planets you've identified; any world's show on the HUD while it's targeted, and the orbit planner (O, then 6) can hold the ship at one.

## Gravity: patched conics plus third bodies

Gravity is still patched conics (`sim/gravity.ts`): the pull is the innermost sphere of influence's body's, and the ship's velocity is kept relative to it. A balance of two pulls can't come out of that alone, so it now has two corrections on top, which are what make the points real:

- **In a star's frame, each planet's own pull, and in a planet's frame each of its moons'**, in full out to 3 Hill radii and tapering to nothing by 6 (`pullReach`). The taper is radial, so the force stays conservative (no energy gained or lost by flying round). A moon's reach is cut short of its planet's SOI edge (a few moons' six Hill radii would reach past it, into the star's frame where moons don't pull).
- **In a planet's (or moon's) frame, its parent's tide**: the parent's pull on the ship less its pull on the frame body (which the carried frame already supplies), plus the pulls of the frame body's siblings (a moon's fellow moons) on the ship, all fading in over the outer 30 % of the SOI. Deep inside an SOI it's zero, so orbits there stay exact Kepler orbits and time warp's rails stay valid, except near a moon, whose pull is real there: an orbit round a planet close to one of its moons drifts, and the settled autopilot re-trims it when it leaves its band.

At an SOI's edge, a planet's or a moon's, the two are the same acceleration, so crossing the boundary no longer jolts the ship (the old switch jumped by about the planet's whole pull; at a moon's edge, until SPACE-90, by the moon's, since moons pulled only inside their SOI). `moonGravity.test.ts` checks every moon's edge, and that the planet's stays smooth. `Gravity.vec` includes the corrections; `Gravity.g` is the body's own pull. Time warp's rails (`sim/timewarp.ts`) include them too, with the other bodies taken where they were at each substep (`perturbation(…, at)`): a frame at ×100,000 is ~1,600 s, and with the planets left where the frame ends a ship drifting at L1 was ~600 km off after ten days instead of 0.3 km (`rails.test.ts`).

The orbit planner's highest orbit round a world is 0.7 of its SOI, where the tide starts (`maxOrbitR`), so every orbit it offers is an exact Kepler orbit that the settled autopilot can coast and warp can hold. The old ceiling, 0.8 SOI, was inside the tide: a settled orbit there left the autopilot's band in 3 days and the SOI within 3 orbits (`tideOrbit.test.ts`). Stations are still placed below 0.48 SOI, as before.

## The points

L1 and L2 sit on the line from the parent through the planet at a fixed share x of its distance: position x·r, velocity x·v, acceleration x·a (the planet's Kepler acceleration). On a circular orbit that is turning with the planet; on an eccentric one the line also breathes in and out with it. L3, L4 and L5 are free orbits (below).

| Point | Where | In the sim |
|---|---|---|
| L1 | between the two, about a Hill radius short of the planet | unstable (e-fold 1 / (2.53 n): 23 days at Earth) |
| L2 | beyond the planet, a Hill radius farther | unstable, the same |
| L3 | opposite the planet | free orbit |
| L4 | 60° ahead | free orbit, stable |
| L5 | 60° behind | free orbit, stable |

L1 and L2 are **solved against the force the ship feels** (Newton on the parent's pull plus the planet's tapered pull plus the centripetal term), so a ship there at the point's velocity needs no thrust, and the instability is real: left alone it leaves. Every pull there goes as 1 / r², so the x that balances on the mean orbit (semi-major axis, mean motion) balances at every r: this is the elliptic three-body problem's homographic solution, exact for any eccentricity (up to e = 0.06 here), and a ship on it needs no thrust there either. (The points used to be re-solved each step from the instantaneous r and ω with velocity ω × position, which slid them along the line, ~40 m/s at e = 0.026, and left out the planet's radial motion; the hold, steering for the point's place and its stated velocity at once, hung ~100–800 m off and never settled. The hold tests had made the orbit circular; they now also fly the real one.)

L3, L4 and L5 are 14+ Hill radii from the planet, where the taper has removed its pull, so each is a **free Kepler orbit with the planet's period**: the planet's own orbit with its mean anomaly shifted by 180°, +60° or −60° (`trojanRel`). That is exact however eccentric the orbit, and a ship there needs no thrust. (In reality the planet's faint pull makes L4 and L5 librate over thousands of years and L3 drift over decades; neither shows in a game session.) L4 and L5 are stable only above the Routh mass ratio of 24.96 (`trojansStable`), which every planet and moon here clears.

## Holding at a point (orbit planner, key 6; HX-8200 and up)

Planner → 6 (L-point) → **R** steps L1…L5 → **[ ]** sets the orbits to phase over (L3–L5) → Enter. The planner shows the point, how it gets there (TRANSFER), and the cost. Holding feeds forward the point's acceleration less the ship's own gravity (which near L1 and L2 is nearly all of it), so it costs next to nothing; the autopilot panel and maneuver guide show the offset, the drift and the propellant burned.

**L1 and L2** are flown to directly (an FTL leg, dropping at rest relative to the planet, then a few hundred m/s to match the point).

**The FTL leg flies in the destination's frame** (`destVel` in `sim/autopilot.ts`): its speed, which falls to 0.8 × the distance closing in, is relative to where it's going, and the ship is carried along with that. Out at the points the frame is the star's, where a point or a gate moves at its planet's orbital speed (30–45 km/s); chasing it at 0.8 × the distance in that frame, the ship hung ~40–55 km behind it for good, short of the 30 km drop-out, and never arrived (`ftlLeg.test.ts` flies the leg, the drop and the hold to L1, L2 and L4).

**The hold compares the ship where it will be at the end of the step** (`ship.pos + ship.vel · dt`): the game loop moves the bodies, and so the point, to the step's end before the ship moves (`sim/update.ts`). Compared where it was, it settled a step's motion ahead of the point, which moves at the planet's orbital speed in the star's frame: 0.9 km at 60 fps, 0.45 km at 120, and the guide never ticked off the approach. The hold tests now step in the game's order.

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

## Moons' points

A moon's five points are its orbit's round its planet, worked out by the same code as a planet's (`lagrangePoints(moon)`), and they're real in the sim because moons pull in their planet's frame (the gravity section above):

- **L1 and L2** balance the planet's pull, the moon's and the centripetal term, as a planet's do. A heavy moon's (mass ratio over ~0.004, like the home world's Venydes 3 a at 0.018) can lie inside the moon's own SOI, where the ship is in the moon's frame and the planet's pull comes as a tide fading in toward the edge; the solve (`collinear`) takes that share of it, so they balance there too.
- **L3, L4 and L5** are free Kepler orbits round the planet with the moon's period, as a planet's are round its star. A heavy moon's tapered pull still reaches its L4 and L5 a little (its six Hill radii pass 60°), which the hold pays for.
- **Accelerations are absolute** (`railAcc`): a point's includes its parent's own fall (a moon's: the planet's round its star), and the hold subtracts its frame body's the same way, so a hold in the planet's (or the moon's) frame needs no thrust at a balance point, as one in the star's frame doesn't. The release planner's drift (`closestApproach`) flies with the same absolute acceleration.
- **Getting there:** the planner (O, then 6, with a moon targeted or chosen) and the nav computer (search a moon's name and L, `Venydes 3 a L4`) take a moon like a planet: straight there for L1 and L2; a phasing transfer round the planet for L3–L5 (a moon's period is days, so three orbits are days of coasting, minutes under warp). **A heavy moon's L4 and L5 are flown to straight** (`phasingReaches`): its pull reaches past 60°, so the departure gate (7 Hill radii ahead, clear of its pull) would lie beyond the point. About one moon in twelve (mass ratio over ~0.006); straight there costs about the moon's orbital speed (median 8 km/s).
- **Targets:** target a moon and its five show and can be picked, as a planet's do; the info panel and the planner say "between it and its planet".

Tested in `moonLagrange.test.ts`: a ship left at a light and a heavy moon's L1, L2 and L4 keeps pace with no thrust; the autopilot settles on each flown in the planet's (or moon's) frame the way the game steps it, and holds on nothing; a phasing transfer reaches a light moon's L4 in three orbits. Checked in the game (headless): from 2·10⁹ m out, Venydes 3 a's L1 (inside its SOI) and L4 both settle and hold at 0.0 m and 0.00 m/s.

## Targeting the points (`sim/lpoints.ts`)

The points of every planet the radar has found are targets (`LTarget`, kind `lpoint`; they're worked out from the planet on rails, but each keeps its identity so `g.target` stays equal to itself). A targeted point is brought up to date every sim step, after the bodies move (`refreshTarget`), so the pivot and the HUD read where it is now, under time warp too (it used to be refreshed only when the HUD drew the points).

- **Which show:** a planet's five appear only while **that planet, or one of its points, is the target** (`lpointsShown`): target a planet and its L1–L5 come up; target one of them and all five stay, so you can hop between them. With anything else targeted, none show (every known planet's five at once cluttered the view).
- **T** aims at a shown one (a marker is picked up to 0.35 rad off the nose), **G** cycles them with the bodies and stations by distance, and a click on its marker picks it. The system map (Shift+O, a click on a point's diamond), the nav search and the radar's swarm contacts reach any planet's points.
- **Shift+T** pivots onto the targeted point and locks on it, like any target.
- **Marker:** a cyan diamond (hollow at L1–L3, filled at the stable L4 and L5) with name and distance, at any distance (with an edge arrow when the targeted one is off screen).
- **A hold at a point targets it:** engaging one (the planner or a nav route) makes the point the target, not its planet.
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
- **Moons' points on the system map.** A moon's five would sit in a cluster round its planet at the map's scale; only planets' are drawn there. Swarms and depots are planets' only.
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

## Ideas for next

Not built; roughly by value.

1. **The trip from low orbit** to the gate or an L-point: a planned escape burn instead of "thrusters until FTL works".
2. ~~Lagrange points of moons~~: built (see "Moons' points"). Left: their points on the system map when zoomed in on a planet, and swarms or depots at a giant moon's L4 and L5.
3. **Halo and Lissajous orbits** round L1 and L2: the saddle's centre mode (ν) is already computed, so a ship could fly a bounded orbit about the point, as real missions do, for less station-keeping.
4. **Station-keeping Δv against the estimate:** show what the hold has actually burned beside the planning figure (`dvYear`).
5. **Swarm hazards:** dust and micro-impacts at speed, as in a ring's belt.
6. **Swarm radar and scanner detail:** a density map in the radar window, and scan stages that reveal rock counts and metal share.
7. **Time the shadow cost** of the swarm casters (up to 600 instances a cascade) on a real GPU; the full game has not been run in a browser.
8. **A full NPC loop test** (spawn, travel, dock, launch) at a depot with the real `Game`.
9. **Planet-branch release as a plan:** aim for a chosen periapsis so a ship can be sent toward the planet on purpose and captured (needs a capture-burn planner).
10. **Eccentric orbits for L1 and L2:** the points now breathe exactly with the planet's orbit, but the saddle (`saddleModes`, the drift times, the release) is still the circular one; for a high-e planet its rate changes round the orbit.
11. **A save and load test** for the new state: `navRevs`, found swarms and a phasing transfer in flight.

## The approach on a weak bus

The autopilot's thruster law asks for up to 1,200 m/s², and its braking plan assumed the orbit computer's rated deceleration. A ship whose bus can't feed that (a flat battery after the FTL leg, dim starlight far out) gets less than it asks, overshoots the point and swings round it without settling. The autopilot now learns the acceleration the thrusters actually deliver (`Autopilot.accCap`: what came out when it asked for more, creeping back up while it asks for about all of it) and brakes within 60 % of that. The panel shows a THRUST row when the bus is limiting it. Tests feed the autopilot through a mocked bus capped at 3.6 and 1.2 m/s² (`lagrangeHold.test.ts`).

The FTL drop leaves the ship 235 m/s from L1 and L2 (they move faster than the planet by n × their distance from it), so the last km is a real braking run, not a drift.
