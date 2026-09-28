# Docking

Stations are Coriolis-style cubes, 1–1.6 km on a side. The geometry is in `sim/stationGeom.ts`
and the mesh in `render/stationMesh.ts`.

## The station

- **Spin:** each station turns about the axis through its front face, fast enough for about
  0.5 g on the hangar wall: `spinRateFor`, a turn a minute or so.
- **Slot:** a 0.4 × 0.12 slot in the middle of the front face (460 × 140 m on a 1,150 m station)
  lies on that axis. It turns in place: line up with it and match its roll.
- **Tunnel:** 0.1 S deep, from the slot to the hangar.
- **Hangar:** a cylinder about the axis, radius 0.42 S, 0.82 S long.
- **Pads:** 18 pads on the hangar's curved wall, in 3 rows of 6 with alternate rows staggered.
  They're 80 m across on a 1 km station. The spin makes that wall "down".

## Flying it (`sim/docking.ts`)

1. Target the station within 10 km and press **K**. That sends a request; traffic control answers
   after 4–8 s with a pad (random for now). A DOCKING progress panel tracks the procedure: get within
   10 km, request docking, approach the slot, enter, land on the pad.
2. **Approach control:** within 3 km of the station, flight assist caps speed at 150 m/s. The HUD
   outlines the slot (turning with the station) and marks your pad with its number and distance.
3. **Inside** (tunnel or hangar):
   - flight assist works against the turning structure (orbit + ω × r), so hands-off you hold still;
   - the ship is turned with the station ("rotation correction");
   - docking thrusters take over: 20 m/s², 100 m/s top speed, tapering along a braking curve to
     5 m/s at the wall.
   There's no sunlight inside.
4. **Land on your pad:**
   - under 6 m/s relative to it;
   - top of the ship toward the axis;
   - within the pad.

   You're then docked and held on the pad as the station turns.
5. **Docked:**
   - external (shore) power (2 MW, its own input on the bus and in the schematic) charges the battery;
   - the station brings the hull to about 293 K;
   - "refuel" fills the tanks (free for now);
   - outfitting (Shift+U) works only while docked;
   - time warp is allowed.
6. **K** launches you off the pad at 25 m/s; fly out through the slot.

Touching the hull, the tunnel or the hangar walls anywhere else bounces you back to your last clear
position. Faster than 35 m/s it destroys the ship.

## Docking computer (`sim/autodock.ts`)

An avionics unit (U → DOCKING tile, key K) from Wharfside Avionics:

| Unit | Clearance | Engage from | Approach / inside | After launch |
|---|---|---|---|---|
| WD-100 Harbor | you request it (K) | 10 km (with the pad granted) | 80 / 30 m/s | — |
| WD-300 Berth (default) | requests it itself at 10 km | 50 km | 150 / 60 m/s (up to 1.5 km/s far out) | flies you out |

It flies these phases:
0. **approach** (WD-300 engaged from afar) to within range, then **wait**: request sent, holding
   still until traffic control answers.
1. **hold:** a point on the spin axis 600 m in front of the slot, at rest against the station's orbit.
2. **align:** nose to the slot, wings along its long side, rolling with the station.
3. **enter:** down the axis to the hangar, level with the pad row.
4. **descend:** out to the pad, top toward the axis, settling at 2 m/s. The normal touchdown check
   docks it.

The WD-300's launch adds **rise** (back to the axis) and **exit** (out to the hold point), then hands
back control.

Guidance:
- a braking-limited speed profile toward each point (8 m/s² planned, 25 m/s² available);
- matched to the station's structure inside the hull (orbit + spin), and to its orbit alone outside
  (the spin term would be ~100 m/s a kilometre off the axis);
- it spends real propellant and power; one test docking from 30 km used about 1.5 t of H₂.

Any thrust key hands control back. Time warp is blocked while it flies.

Tested from 30 km: the WD-300 got clearance at 9.5 km and docked in 165 s. The WD-100 docked from
7 km in 145 s after a manual request.

## Frame subtleties

The ship's position and velocity are relative to its frame body (patched conics). Each step it's
carried with that body before its own motion is applied. Mid-step, then, it lags an orbiting
station by that station's orbital speed times the step: about 150 m at 7.5 km/s.

Everything that compares the ship with the turning station therefore uses the offset from the end
of the last step (`Game.inStationRel`), or station-local coordinates (the bounce):
- the flight-assist frame velocity (ω × r),
- the docking-thruster limits.

Using the mid-step position put ω × r about 15 m/s wrong, and bounced ships out through the wall.

## Not yet

- Traffic and other ships.
- Pad assignment by ship size.
- Station services with prices.
- Pad numbers painted on the pads (the HUD labels them).

## Getting round the station

The docking computer never flies through the station on its way to the hold point. If the straight line would pass within 150 m of the station's circumscribed sphere, it heads for a point on a sphere 1.2 station sizes + 250 m out, 0.5 rad further round toward the slot's side. It re-picks that point every step, so it climbs away from the hull and curves round to the front. This matters because the hull spins: its corners move at ~70 m/s, over the 35 m/s crash limit, so any touch is fatal. (`autodock.ts clearPath`; tested from starts all round a station, down to 50 m off the hull.)

## Attitude on the way in

On the way to the hold point (and while waiting for clearance) the docking computer points the nose where it's going, or at the station while it waits, and keeps the ship's roll. Within 250 m of the hold point it turns to the slot's orientation for the align phase. (`autodock.ts`, FACE_SLOT.)

## Entry corridor

The corridor runs 5 km out from the slot along the spin axis (`stationMesh.ts` CORRIDOR_M), widening 4× (CORRIDOR_GROW). 25 approach lights sit along each edge: green on +x, red on −x, like the slot's own lights. They're drawn at least 3 px wide so the corridor reads from far out, and pulses run in toward the slot. The lights are on within 60 km. The walls glow only while you have a pad there.

## Sky stations

Open decks hanging 10–20 km over the ground of worlds with air and a solid surface (not the giants):
most Earth-like and ocean worlds, fewer elsewhere, always one on the home world. They're generated
after the orbital stations from their own RNG stream (`universe/stations.ts`), so adding them
changed nothing that was there. Geometry: `sim/skyGeom.ts`; mesh: `render/skyMesh.ts`; shader:
`shaders/skyStation.frag.glsl`.

- **Where:** fixed in the world's own frame (`Station.sky`: a direction and a radius), at 10–20 km
  over the ground under it (not the mean radius: a mountain range under it doesn't bring it
  closer). Each step it's placed with the world's rotation, and its velocity is the world's plus
  ω × r (`sim/stations.ts`). Its Kepler fields are placeholders (a = its radius, n = the day).
- **Shape** (units of the deck's diameter, 0.9–1.3 km; +z up): a deck disc 30 m thick with its top
  at z = 0; a control tower with a lit cab and a red beacon; a tapering keel underneath and four
  lift-fan pods under the rim. It has no interior: 12 pads sit on top, 8 round the rim and 4 closer
  in, open to the sky.
- **Frames:** it's a station, so within 30 km (5,000 km as your target) flight assist works relative
  to it, which here is the turning ground at its height: hands off, you hover beside it.
- **Docking:** request a pad as usual (K). There's no slot: fly over the pad and come straight
  down onto it, upright, under 6 m/s. Over the deck with a pad granted, flight assist uses the docking
  thrusters and the same braking curve as above a hangar wall, by height over the deck, so holding
  "down" settles you onto it (tested: 120 m over the pad to docked in ~4 s). Docked, the ship sits nose-outward on the pad in the open air
  (sunlight, not "inside"). The HUD marks the pad; the guide's steps are *fly over the pad*, *land*.
- **Docking computer:** hold point straight above the deck's centre (0.87 × size + 200 m up), turn
  upright nose-outward (align), go to 60 m over the pad (enter), settle (descend). It holds the ship
  up against gravity (the station doesn't fall with it: `stationAcc` is only ω²r across the axis)
  and in the air never flies faster than the air allows. Lifting off with a WD-300 reverses it.
- **Rendezvous** (autopilot, nav route legs, traffic): a sky station is low in thick air, so it
  never crosses the air to reach one. Not yet over it (in a cone 3 km + 30 % of the height wide
  above it), it heads for a point just over the top of the air above it, round the world clear of
  the air (`autopilot.ts skyDescent`); over it, it comes straight down at the air's speed limit to
  the usual 2 km standoff. Far off and low, it climbs out for an FTL leg first, as for any station.
  From 300 km up and 2,800 km round a 7,700 km world it takes ~6½ min and ~28 t of propellant.

### The catapult (`sim/catapult.ts`)

Docked at a sky station you can lift off yourself (K), or take the catapult (Shift+K, or the button
in the docked panel): it throws the ship straight up, free, and the ascent program flies it out of
the air with no input.

Why not just throw it hard enough to coast out? At 10–20 km the air is still thick: the ship
(~113 m² nose-on, ~150 t) would lose about half its speed to drag on the way up, so coasting clear of
an Earth-like atmosphere would need ~3 km/s at the pad, and at that speed in that air the hull takes
hundreds of MW of entry heating. Rockets have the same problem and the same answer: climb no faster
than the air allows, then speed up as it thins.

- `airSpeedLimit(ρ)`: the fastest to climb through air of density ρ — under 30 kPa of dynamic
  pressure (about a rocket's max Q), under 20 MW of entry heating, under 1.5 km/s.
- **Catapult:** a free kick straight up to that limit at the deck (~950 m/s from 17 km over a
  1-bar world).
- **Ascent program:** holds the climb at the limit (thrust against gravity and drag, nose turning
  up along the climb), damping drift across the ground. Above the top of the air it hands back
  control, still climbing at up to 1.5 km/s. Any thrust key takes over earlier.
- From 17 km over Venydes 5 (1 bar, top ~77 km) it's clear in ~1 min for ~1.5 t of propellant,
  the hull barely warming. Time warp is off during the ascent.
- Traffic uses it too when leaving a sky station.
