# Farlight

A browser space flight sim built to real scale, in the spirit of Elite Dangerous. You're always in the cockpit: fly between planets on an FTL drive, jump between stars, fall into gravity wells, and manage propellant, exotic matter and solar power.

Built with TypeScript, React and three.js, bundled with Vite.

## Running it
```sh
npm install
npm run dev       # dev server with hot reload
npm run build     # type-check and build a static site into dist/
npm run preview   # serve the production build
npm test          # unit tests (vitest)
npm run lint
```
The build is a static site with relative paths, so `dist/` can be hosted anywhere. The CI workflow (`.github/workflows/ci.yml`) lints, tests and builds every push and pull request. Deployment isn't set up yet.

## Code layout
```
src/
  main.tsx, ui/            React: mounts the game and renders the HUD panels and toasts
    hooks/useGame.ts       creates the Game and subscribes to its HUD snapshots
    components/            Hud (location, gauges, flight cluster, target card), BodyInfo, ManeuverGuide,
                           OrbitPlanner, HelpPanel, StartScreen, Toast
  styles/                  global CSS (theme, HUD, panels)
  game/                    framework-free game engine
    Game.ts                owns all state and runs the frame loop (simulate → render → overlay → HUD)
    constants.ts, types.ts units, ship specs, drive costs; typed bodies, ship, autopilot…
    format.ts              distance / speed / time / mass formatting
    lib/                   seeded RNG, colours, three.js setup
    universe/              procedural galaxy, stars, planets, moons and stations
    sim/                   physics and ship systems: gravity, flight, FTL, orbits, autopilot,
                           maneuver guide, navigation and hyperjumps, station orbits, resources, per-step update
    input/                 keyboard / mouse state and key bindings
    render/                three.js scene renderer, 2D overlay canvas, GLSL shaders
    hud/                   builds the HUD view model that React renders
```
**HUD.** A minimal cockpit: location and jump destination (top left); ship gauges (bottom left: H₂ with Δv, exotic matter with jumps left, battery with net power); the flight cluster (bottom centre: mode, speed, speed-limit or throttle bar, altitude and orbit near a body, and status chips for flight assist, decoupled, cruise and g-load); and the target card (bottom right). The maneuver guide and orbit planner appear top right only while in use. Tab opens the controls, and I the target details. Everything is sized in `rem` off one root font size that scales with the window (14–22 px), so it stays readable on 4K. The canvas labels follow the same scale.

The simulation never touches the DOM. Each frame it steps the physics, draws the 3D scene and the overlay canvas, and about twelve times a second publishes a HUD snapshot (plain strings and flags) that React picks up through `useSyncExternalStore`.

## The universe
- An endless star cluster generated lazily in 10 ly sectors from fixed seeds, so every system is the same on every visit. Only the sectors around you exist; a system's planets are built when you arrive.
- About 100 systems (±~15) lie within the 25 ly jump range of any point. Every star in the sky is a real system within 100 ly; the Milky Way band is the only background.
- The Galactic Core: a supermassive black hole 1,000 ly out, a bright point in the Milky Way from anywhere. Up close it's lensed for real: the black shadow, the accretion disk bent over and under it, brighter on the side coming toward you, and the stars behind it pulled into arcs (docs/blackhole.md).
- Stars sized in solar radii, from red dwarfs to blue B-type stars. Planets in Earth radii, orbits in AU, masses from density.
- Rocky, desert, Earth-like, ocean, volcanic and icy worlds, gas and ice giants with rings, and moons.
- Orbital stations around some worlds (most Earth-like ones, fewer elsewhere, always one at home): 1–1.6 km brushed-metal cubes, about the size of an Elite Dangerous Coriolis station, on realistic Kepler orbits. Most are in low orbit just above the atmosphere, and some are synchronous, high or polar. They have no gravity and are marked with mint squares, and T / G can target them. A station on the far side of a world gets a crossed-out square; other ships behind a world aren't shown at all (sim/sight.ts).
- City lights on the night side of Earth-like worlds: coasts strung with cities, towns inland, roads and streets as you come down (docs/terrain.md).
- Sky stations over worlds with air and solid ground (most Earth-like and ocean worlds, always one at home): open ~1 km decks hanging 10–20 km over one spot on the ground (over the cities on populated worlds, over land where there's a sea), turning with the world, with 12 pads on top, a control tower and lift fans underneath. Land on a pad from above; leave by lifting off, or by the catapult (Shift+K), which throws you up and flies you out of the air hands-off. See docs/docking.md.
- Sound, all synthesised (no files): life-support hum, the drive's warbling idle hum in normal space, thrust rumble, attitude-thruster hiss, FTL spool and whine, hyperspace roar, wind in an atmosphere, the laser, docking chimes, knocks and alarms. Shift+P toggles it (docs/sound.md).
- Lagrange points of each identified planet on the system map (Shift+O), targetable like bodies (T, G, click, the map; I describes them, O plans a hold at the one targeted), and an autopilot hold at any of them from the orbit planner (O, 6; docs/lagrange.md). L1 and L2 are real equilibria of the star's and planet's pulls and really are unstable; L3–L5 are reached by a phasing transfer (a small burn, a few orbits' coast under time warp, a match), at a fraction of the cost of going straight there.
- Trojan swarms: a loose cloud of dark, metal-rich rocks round every giant's L4 and L5, found as contacts and prospected by the radar, mineable with the laser, casting shadows, and depots: open-plate stations with a truss spine and tank farm parked in some of them (docs/lagrange.md); a hold at L1 or L2 can be released onto either branch of its unstable manifold (`[` `]` in the autopilot panel).
- Station contracts (Shift+J): haul crates between stations, run courier packets to other systems against the clock, or fill a station's metal order; plot the route from the job (docs/economy.md).
- Pause menu: Esc with the cursor free (while it's captured, Esc frees it first). The game stands still; resume, controls, sound, object names, save now, new game. Esc also closes the system map first.
- Oxygen: a LOX tank that life support breathes, and a fuel cell burns hydrogen with when the battery runs low; buy it at stations, split it from ice (power-hungry), or scoop it from Earth-like air (docs/power.md).
- All surfaces, the Milky Way sky and the star field are generated by shaders. The game uses no image files.

## HUD
- **Dashboard lamps** above the speedometer: one icon per system, dim when off and lit when on (amber on, cyan drive-related, red warning; blinking while changing). Flight assist, decoupled, autopilot/route/docking computer, FTL cruise, docking; sun tracking, headlights, radiators, heat pump, H₂ vent, fuel scoop, radar sweep, shore power; drive charging, mass lock, hull hot, battery low, power short, time warp, periscope. Hover one (with the mouse free) for a tooltip: its name, on/off, key and live detail. A ring round the icon fills with progress: how deep in a mass lock you are (full at the surface), radiators deploying or stowing, a drive charging.
- **Mass lock exit marker:** while a world's gravity well blocks FTL, a red marker (a ring with a dot and three outward arrowheads) shows the way out: straight away from the world holding you, or a blend when more than one does. It's labelled with the height still to climb, with an edge arrow when it's off screen (`sim/ftl.ts massLockExit`).
- **Approach strip** in the target card: a line from far away to the target's surface (right), with you on it and the approach's milestones marked (gravity (sphere of influence), mass lock, FTL drop, low orbit, atmosphere, scoop zones, ground frame and speed cap; for stations the station frame, autodock range, pad request range and hold point). Your marker points at the target while you close and away from it while you recede. Log-scaled; it zooms in steps as you close in, and the hatched left zone squeezes in what's beyond the window. Hover a mark for details (hud/approach.ts).
- **One selection at a time:** targeting a body or station clears the jump destination, and picking a star clears the target.

## Controls
| Key | Action |
|---|---|
| W / S | Thrust forward / back (FTL: throttle) |
| A / D | Strafe |
| Space / Ctrl or C | Thrust up / down (Ctrl+W closes the tab, so use C when also pressing W) |
| Mouse, arrows · Q / E | Pitch and yaw · roll |
| Shift · X | Boost · all stop |
| Y | Scan the target with the fitted scanner (it must resolve it: angular size ≥ the scanner's resolution). Scans reveal type and size → mass and gravity → orbit → climate, atmosphere, moons and stations; the home system starts scanned |
| M | Navigation computer: a route through waypoints (stars) or to the target (orbit a body, rendezvous with a station, hold at a Lagrange point). Add waypoints by clicking stars (the one under the cursor is highlighted with its distance) or with the search box (/ focuses it): its dropdown finds stars, planets, moons, stations and Lagrange points (type a planet's name and L; here, within jump range, or in a system you name), nearest first from the ship or the last stop; ↑ ↓ Enter pick. A body, station or Lagrange point ends the route with an orbit, a rendezvous or a hold there (a phasing transfer for L3–L5; `[` `]` set its orbit count). Backspace removes the last waypoint; 1–3 route mode (fewest jumps / least exotic / fastest); Enter engages; while flying, Backspace ×2 cancels. It flies every leg: jumps, corona-skimming refuel stops, then the orbit, rendezvous or L-point hold |
| B | Influences: each body's gravitational pull (strongest first; the applied one marked; click a name to target it), whose gravity you're in and the next one ahead, what flight assist is matching, mass lock (and how far to climb), what caps FTL speed, starlight and solar power, shadow, distance to the corona and gas-giant scoop zones, and the heat budget (absorbed, radiated, where the hull settles) |
| U | Ship stats. Avionics: a 2 × 2 grid of tiles (orbit computer, scanner, navigation, outfit) with an icon, key, model and what it's doing (full name, purpose and specs in the tooltip); click a tile or press its key to open it. Electrical: a live schematic (panels and battery feeding the bus, the bus feeding each load; wires thicken and animate with the power flowing, limited loads in red), plus battery flow, charge times at the current bus and what's power-limited |
| Shift+U | Outfit: the utility slots (radiators, heat pump), and refitting when alongside a station |
| Wheel click, Shift+T | Pivot: turn the nose exactly onto the target (or the jump destination), keeping your roll; tracks a moving target until centred, manual steering takes over |
| Shift+L | Headlights: a physical 5 kW LED floodlight (~1.3 million candela, ~20° cone, inverse-square), lighting station hulls and hangars. Invisible next to sunlight; lights a hull within a few hundred metres |
| Z · wheel | Periscope: a narrow-field view from 2× to 1,000× (100× to start; the wheel sets it while it's up). Steering slows by the magnification; markers, picking and planet detail follow the zoom |
| Shift+Y | Radar: "scan" sweeps 10 AU (400 kW for 4 s) and remembers everything it finds, by class only ("Unidentified gas giant") until the scanner identifies it; it draws nothing between sweeps. A fixed scope (nose up, log-distance rings) above a scrolling contact list; rows target, "identify" starts the scanner (Y). The nav search only offers in-system objects the radar has found |
| Shift+K | Call a fuel tanker |
| K (at a station) | Docking: with a station targeted within 10 km, request a pad; docked, launch. With a docking computer (WD-300 by default) K engages it from up to 50 km: it requests clearance, flies in, docks, and flies you out after launch. Fly in through the turning slot on the front face and settle onto your pad on the hangar wall; at a sky station, come down onto the pad from above (see docs/docking.md). Shift+K docked at a sky station: the catapult |
| , . | Time warp: 1× up to 100,000× (moons orbit in a minute or two, planets visibly spin). The ship coasts on rails while it runs; it won't start (and drops back to 1×) in FTL, while charging, jumping, venting or flying a route, during an autopilot manoeuvre, on any thrust key, or within a minute of an impact |
| R · Shift+R | Vent hydrogen to cool the hull · deploy or stow the radiators (R is the orbit planner's direction key while it's open) |
| I | Target info: size, mass, gravity, climate, its orbit, and your speed and orbit relative to it (shown in place of the controls list) |
| Shift+Z | Flight assist on / off |
| V | Decoupled: turn without changing course (normal space and FTL) |
| J | FTL drive |
| F | FTL cruise control: the throttle holds. Off, it spools down when you release W and the drive idles; only J drops you out |
| Shift+O | System map: every orbit, station and ship the radar knows, your orbit and the autopilot's, in one zoomable 3D view (drag turns, wheel zooms, click targets and centres) |
| Shift+N | Object names on the HUD's markers (bodies, stations, ships, stars) on / off; the markers stay |
| T / G | Target body or station ahead / cycle by distance |
| Shift+G | Travel to the target on the autopilot: a rendezvous beside a station, a hold at a Lagrange point, the default orbit round a world or star. It charges the FTL drive and flies the leg when that's quicker (climbing out of a mass lock first); O shows its status, Backspace ×2 disengages |
| Click | Target the body, station or reachable star under the cursor (or the crosshair, with the mouse captured). Clicking empty space captures the mouse |
| N / H | Pick a star system (aim at it, or cycle by distance) / hyperjump (H again during the charge cancels it) |
| O | Orbit planner (equatorial, polar, stationary, hold position). While the autopilot flies, O opens its status instead: target versus current orbit, how far off you are, time and Δv used |
| Backspace ×2 | Disengage the autopilot (from its status panel, confirmed within 3 s; also clickable). Thrust keys and J no longer switch it off |
| L | Orbit preview ring on / off: the planned orbit (amber) or the one the autopilot is flying (cyan), drawn around the body |
| P | Turn the solar panels to the star |
| K | Call a fuel tanker |
| ` | Performance overlay: FPS, frame-time graph, per-stage timings, GPU time by category (terrain, air, clouds, sky, post…; see docs/perf.md) |
| Tab | Hide the controls panel (a colour-coded keyboard schema with a legend by group) |
| Click a panel heading | Collapse / expand that panel (all but the speed readout; remembered per browser). Release the mouse (Esc) first if it's captured |

## Avionics
The ship's automation comes from fitted computers, commercial units with a maker, model and name. Features are switched by each unit's capabilities (`src/game/avionics/catalog.ts`). The default ship carries the best of each:

| Kind | Line-up (basic → best) | Default |
|---|---|---|
| Orbit computer (Hesperus Avionics) | HX-6100 *Plumbline* (equatorial and hold, thrusters only, no preview) · HX-8200 *Apsis* (all orbits, preview ring, FTL leg) · HX-9100 *Periastron* (plus faster insertion and deviation readouts) | HX-9100 |
| Scanner (Argus Optics) | AS-300 *Glance* (60″) · AS-700 *Watchman* (5″) · AS-1200 *Panoptes* (0.2″) | AS-1200 |
| Navigation (Meridian Systems) | MNV-3000 *Pathfinder* (in-system) · MNV-5000 *Wayfarer* (≤ 5 jumps) · MNV-7000 *Longitude* (unlimited, refuel stops, optimisation) | MNV-7000 |

## Physics
- **Orbits:** planets orbit their star and moons orbit their planets on near-circular Kepler orbits (e ≤ 0.06), computed exactly from the sim clock, so a moon around a giant may lap it in hours while an Earth-like world takes a year.
- **Terrain:** rocky, desert, Earth-like, ocean, volcanic and icy worlds have real relief: continents, ridged mountain ranges (up to ~12 km on an Earth, ~6 km on a Moon), impact craters on moons, mountain shadows and detail that keeps coming as you descend (LOD down to ~8 m, bump shading below that). You land on what you see; ALT is height above the ground, and below 30 km flight assist works relative to the turning ground, so you hover over one spot. Near the ground flight assist also caps your speed at 0.2 × your height per second (min 8 m/s), falling included, so you ease down onto it. See docs/terrain.md.
- **Atmospheres:** each world's air is generated: a surface pressure (from Mars-thin to 95-bar Venus-like) and a mix of gases, which set its density, its greenhouse-warmed surface temperature and how tall it is (the info panel shows all of it once scanned). Air thins exponentially with height. Under thick, hot air the hull can't shed heat (the sky glows back at it): a Venus-like surface locks out the drives, the hottest cook the ship in minutes. It drags on the ship (terminal speed ~85 m/s near an Earth-like surface) and heats it on the way in (no heat shield: a steep 6 km/s entry takes the hull past 700 K; fly nose-first and shallow). The sky scatters sunlight: blue by day with the stars hidden, red at sunset, a glowing limb from orbit, haze on distant terrain. Earth-like and ocean worlds have a real cloud layer ~9 km up that you can fly above or below, casting shadows on the ground. See docs/atmosphere.md.
- **Saving:** the game saves itself every 15 s and when you leave the page, and resumes where you were: the system and clock, the ship and everything fitted, docked, the autopilot or docking computer mid-manoeuvre, a hyperjump in transit (you arrive), scans and radar contacts, and every other ship in the system mid-errand. New game (two clicks) is in the controls panel (Tab). See docs/saving.md.
- **Rings:** up close a ring is a belt of rock: tens of thousands of pebbles, rocks and 500 m boulders around you, generated on the GPU, fading into specks and then the banded disc far off. The orbit planner's ring orbit (5) takes you into the belt moving with the rocks, and inside it flight assist works relative to them (800 m/s belt limit), following the ring's bands and gaps and orbiting with it (inner rocks overtake outer ones): match its orbit and fly among them. From afar it's the banded disc. See docs/rings.md.
- **Traffic:** other ships (freighters, couriers, tankers…) fly on the same code as you: their autopilots take FTL legs and insert into orbits, their docking computers ask for pads, fly the slot and land, and they launch again (a flash as they enter and leave FTL, a trail streaming behind them up to 0.2 AU long; yours too). See docs/traffic.md.
- **Gravity:** patched conics. The innermost body whose sphere of influence you're in pulls on you, and your velocity is kept relative to it as it orbits, so hovering, landing and orbiting work as if it stood still. Crossing into another body's sphere of influence re-expresses your velocity without any jump. On top: in a star's frame each planet's own pull within 3–6 Hill radii, and in a planet's frame its star's tide near the SOI's edge, so the acceleration is continuous across it and Lagrange points exist (docs/lagrange.md). Landing above 150 m/s destroys the ship.
- **Propellant:** fusion torch with 200 km/s exhaust velocity, costed with the rocket equation. A full ship has about 183 km/s of Δv.
- **Exotic matter:** runs the FTL drive, and hyperjumps cost `2 + 0.02 × ly²` kg.
- **Power:** a 200 kWh battery charged by solar panels. Output follows starlight flux and panel angle, and drops to zero in a planet's shadow.
- **Refuelling:** skim a star's corona or a gas giant's upper atmosphere with a fuel scoop (an outfit module; the ship starts with the FS-5; normal space only), mine ice on the ground, or call a tanker. Scoops: FS-1 Draught (hydrogen only), FS-3 Corona (hydrogen and exotic matter), FS-5 Maelstrom (both, twice the intake). Nav refuel stops need a corona scoop. The corona scoop works where starlight is over 25× Earth's (a Sun-like star's 0.2 AU) and reaches its full rate at 100× (0.1 AU, ~21 radii): about 1.2 kg/s of exotic matter and 2.5 t/s of hydrogen. Nav routes stop there, nose on the star.
- **Radiation:** cosmic rays everywhere, stellar wind and X-rays (fierce near hot stars), Jupiter-style radiation belts round gas giants, and the galactic core's X-rays. The hull stops most of it, and a powered magnetic deflector turns away the charged particles, though not X-rays. The crew's dose builds up (RADIATION gauge, radiation lamp, influences panel B): warnings at 0.25, 1 and 3 Sv, fatal at 5 Sv. It heals by half every two days, and a station's medbay clears it for credits. See docs/radiation.md.
- **Heat:** in vacuum the hull can only shed heat by radiating it, so it drifts slowly (hours) toward the temperature where that balances starlight, nearby worlds' glow and the ship's own waste heat (HULL gauge, B for the breakdown). Nose-on to a star it shows 6× less cross-section than side-on. At 400 K you're warned, at 500 K the solar panels are feathered, at 600 K the FTL drive and hyperdrive can't be charged, at 800 K the structure is weakening, and at 900 K the hull fails. Hyperjumps drop you where starlight is 20× Earth's (a Sun-like star's 0.22 AU). To cool down fast, R vents hydrogen through a heat exchanger: 50 MW of cooling for ~8 kg/s. Details in docs/thermal.md.
- **Power:** everything electrical shares one bus: the solar panels (up to 1.5 MW) plus the battery's discharge limit (the stock EB-200: 200 kWh, 1 MW = 5C; it charges at 1C). Loads are served in order: life support and avionics, drive charging, the FTL drive (600 kW, or it drops out), thrusters (1.2 kW per m/s²), the heat pump. Drive charging takes a fixed energy (FTL 5 kWh, a hyperjump ~35 kWh), so on a weak bus it just takes longer: ~15–20 s for FTL and ~2 min for a jump on the stock battery. The ship starts with the best of everything: the HP-600 battery, FS-5 scoop, KR-25 radiators and KH-2 heat pump, and the top avionics. Batteries are swapped at a station (Shift+U): EB-500 (500 kWh, 5C), HP-300 (300 kWh, 30C: FTL at full rate, jumps in ~14 s) and HP-600 (600 kWh, 50C: jumps at full rate, 5 s). See docs/power.md.
- **Station lights:** floodlight pools on every face (~30 lux: invisible in sunlight, what you see by in shadow once your eyes adapt), blinking corner navigation lights, and green/red approach lights running in to the slot, so a station in its world's shadow is still visible. An entry corridor runs 5 km out from the slot along the approach line, widening 4× into a funnel: its edges are marked by approach lights (green on one side, red on the other, pulses running in toward the slot), always on within 60 km, and with a pad granted its walls glow faintly green.
- **Ring rocks** are solid: fly into one and the hull takes damage by the closing speed and the rock's mass. Nose-first you meet far fewer (you're ~6 m across that way, ~15 m side-on); co-orbiting they're harmless bumps (docs/rings.md).
- **Economy:** credits (25,000 to start); stations charge for fuel, repairs, outfitting and tanker calls, each at its own prices; a 200 t hold (it counts in the ship's mass) for metal from the mining laser (rare metal-rich rocks pay best), sold at any station. Fuel you gather yourself is free (docs/economy.md).
- **Ring mining:** a mining laser (Shift+M) boils ice off the rock at your crosshair; the fuel scoop catches it as propellant (~340 kg/s from the stock ML-6), at the cost of battery and hull heat (docs/rings.md).
- **Belt protection:** ring dust wears the hull at speed (a magnetic deflector stops most of it), and a collision radar marks rocks on a collision course and, the better one, steers you clear. Two more utility slots carry them (docs/rings.md).
- **Damage:** hard landings, bumps into stations and overheating wear the hull's integrity (a scrape is nothing, damage grows with the square of the speed, a whole hull at what used to be instantly fatal); docked, the station repairs it. See docs/damage.md.
- **Docking:** stations are Coriolis cubes spinning about the axis through their docking slot, with a cylindrical hangar and 18 pads on its wall (the spin makes it "down", ~0.5 g). Request a pad (K), fly in (approach speed capped at 150 m/s, docking thrusters inside), land gently. Docked: shore power, hull cooling, free refuelling, outfitting. Hitting the structure bounces you, and above 35 m/s it's fatal. See docs/docking.md.
- **Outfit (Shift+U):** three utility slots (fuel scoops, radiators, heat pump) plus the battery, refitted while docked. Modules: deployable radiators (KR-12 / KR-25; Shift+R deploys them, thrust capped at 3 g while out) and a heat pump (KH-2) that drives them hotter at a steep power cost.
- **Decoupled flight (V):** rotation stops steering. In FTL the drive keeps pushing along its last direction, dropping out keeps that course, and in normal space flight assist stops damping drift. You can flip 180° and fly backwards; a crossed-circle retrograde marker shows where you came from. Thrust still works along the ship's axes, and X still stops you.
- **Local frame:** within 30 km of a station (5,000 km if it's your target — stations round big worlds orbit faster than the speed limit, so this is how you catch them), flight assist, the speed readout ("REL. <station>") and the speed limit are relative to the station. Hands off, you hold station beside it. Flying in from the planet's frame, flight assist burns real propellant to match the station's orbit. Dropping out of FTL within 30 km puts you straight into the station's frame, and flying at a station in FTL drops you out 100 km from it, matched to its orbit (`sim/ftl.ts STATION_DROP`; not when you're flying away from one).
- **Hyperjumps:** limited to 25 ly. The drive swings the nose onto the destination while it charges (5 s), then the ship accelerates straight out of the system for 5 s, its speed growing exponentially from walking pace to ~600,000 c, so nearby worlds fall away first and ever faster and the star last (the destination can't be behind a planet or the star; nav routes move clear on their own). Then the transit is a real flight through the star field: every system within 100 ly of the path sits at its true position, nearby stars sweep past with parallax, and all of them stretch into streaks that grow and shrink with the speed (easing in and out, peaking near 5 ly/s, about 160 million c; the speedometer reads it in c). The destination swells into a blaze before you arrive, and you drop in where its light is 20× Earth's (a Sun-like star's 0.22 AU, where it spans about 2.4° of sky), still in FTL. Transit takes 8 s + 0.32 s per ly, picking up at the departure's speed. Reachable stars near the crosshair get a small ring and label; aim at one and press N.
- **Exposure:** *currently switched off* (`AUTO_EXPOSURE` in render/exposure.ts; fixed levels, still HDR + tone-mapped). When on, the view adapts like an eye. The frame is rendered in HDR with every light at its real brightness relative to sunlight, the range squashed (level^0.4) so exposure only swings ~40× (the night sky at 1/40 of a sunlit surface), then metered and tone-mapped. Next to a sunlit world the stars dim to about a third and the Milky Way to about 40% (really both would vanish), and in a world's shadow the eye adapts in a second or two until the stars and a station's floodlights come back. The system's star (disc and glow) and the nav, approach and pad lights and approach corridor look the same at any exposure and don't affect it, so the star in view doesn't black out the sky.
- **FTL course:** the autopilot's FTL leg (yours and other ships') flies a planned course round the gravity wells, not the straight line: near a body the drive is held in proportion to the altitude, so the quickest way round a star or a giant is a wide spiral, not a skim past it. It's ~25 % quicker on average, up to twice as quick when the star is in the way, and keeps clear of every world's drop-out altitude. The system map draws it while it's flown (docs/ftlpath.md).
- **Maneuver guide:** orbit insertion, hold position, hyperjumps and tanker rendezvous show a step-by-step progress panel with ETAs and Δv per step.

## Debugging
`window.farlight` is the running `Game`. `farlight.step(seconds)` fast-forwards the simulation from the browser console, and `farlight.ship`, `farlight.cur` and `farlight.power` expose the live state.
