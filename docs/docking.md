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

1. Target the station within 10 km and press **K**. The station grants a pad (random for now).
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
   - shore power (2 MW) charges the battery;
   - the station brings the hull to about 293 K;
   - "refuel" fills the tanks (free for now);
   - outfitting (Shift+U) works only while docked;
   - time warp is allowed.
6. **K** launches you off the pad at 25 m/s; fly out through the slot.

Touching the hull, the tunnel or the hangar walls anywhere else bounces you back to your last clear
position. Faster than 35 m/s it destroys the ship.

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

- Docking computer (automatic docking).
- Traffic and other ships.
- Pad assignment by ship size.
- Station services with prices.
- Pad numbers painted on the pads (the HUD labels them).
