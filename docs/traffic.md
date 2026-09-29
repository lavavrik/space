# Traffic

Other ships go about their business in each system (`sim/traffic.ts`, drawn by `render/Traffic.ts`). There are 3 + 2 per station of them, at most 12, with a kind (freighter, courier, tanker…) and a name, the same every time you visit a system.

## What they do

Each ship is flown by the same code as yours (`sim/traffic.ts`): gravity and patched conics, the FTL drive with its speed limits and drop-outs near worlds, the orbit autopilot (FTL transfer legs, insertion, circular orbits, station rendezvous) and the docking computer (it asks traffic control for a pad, waits, flies to the hold point, lines up with the slot, goes in and lands; after launch it flies out). Every ship has the best gear, like yours, and plenty of power.

**How:** each ship has a *pilot context*, `Object.create(game)`, with its own `Ship` and its own copy of every piece of flight state (frame body, station frame, dock and request, docking computer, power bus, messages, …; `pilotFor`). Everything else (the system, the sim clock) is read through to the game. The flight functions take that context in place of the game, so they run unchanged, and nothing they write reaches your ship. One step (`fly`) is the normal-flight branch of `sim/update.ts`: charge, frames, then the docking computer, the autopilot or hands-off flight assist, then contact with worlds and stations. Before the bodies move each frame, each ship's offset from its frame body is noted (`rideTraffic`), so it's carried along with that body as yours is.

**The captain** only decides; the computers fly:

| Task | What happens |
|---|---|
| **docked** | on a pad for 40–240 s, tanks filled, then launches (K) |
| **launch** | the docking computer lifts it off the pad and flies it out through the slot |
| **travel** | picks somewhere else: a station (60 %: autopilot rendezvous) or a world (autopilot into a circular equatorial orbit). The autopilot takes an FTL leg when it's worth it, climbing out of any mass lock first, exactly as for you |
| **dock** | matched with the station, the docking computer takes over: request, wait for the pad, hold point, slot, pad |
| **orbit** | in orbit round the world for 60–300 s, then travel again |

A leg taking over 30 min is given up for another destination. A ship that crashes (it shouldn't) is replaced by a new one docked at a station. At first most ships are docked and the rest in orbit, with their waits staggered so the first leave within a minute or so.

**Time warp:** a ship on a pad or coasting in orbit takes the warped step at once (on rails, like yours). One that's manoeuvring is stepped at most 10 × 0.1 s per frame, so under high warp it falls behind the clock (still carried with its frame body).

At stations they go through traffic control like you (docs/docking.md): a free pad each, and the slot one ship at a time, queueing on its axis. **Collisions (`sim/shipContact.ts`):** every ship, yours included, is a sphere of 30 m (their ~60 m hulls).
- A contact bounces the two apart, keeping momentum and returning 30 % of the closing speed. The lighter ship is thrown further.
- Both take damage from the closing speed: nothing under 3 m/s, about 13 % at 20 m/s, and a whole hull at 50 m/s.
- Ships in FTL, docked or landed don't collide.
- Checked: a 2 m/s bump just bounces; at 20 m/s each ship loses ~13 %; at 60 m/s both are lost.

**The corridor as a traffic light:** while another ship has a station's slot (lining up, going in, coming out), the corridor's walls glow and its approach lights turn amber, their pulses running the way that ship is going: in for an arrival, out for a departure. When it's clear they're back to green and red with the pulses running in.

## Radar, targeting and scanning

Ships are targets like bodies and stations (`types.ts Npc`, kind `ship`).

- **Radar:** a sweep picks them up within its range (as "ship" contacts), and they stay tracked as they move.
- **Selecting:** you can pick one with T, G, a click or the radar window. The selected ship gets a cyan triangle (bodies get circles, stations squares), a scan arc while it's being scanned, and an edge arrow when it's off screen.
- **Scanning** (Y; a 60 m ship resolves at ~60,000 km with the best scanner):

| Scanned | Reveals |
|---|---|
| 25 % | class and name ("Hauler Meridian") |
| 50 % | what it's doing (docked at, launching from, FTL transfer to, closing on, waiting for clearance, docking at, in orbit round) |
| 75 % | where it's bound |

  The info panel (I) shows these rows plus your distance and relative speed. Your home system's ships aren't known in advance; you have to find them.
- **Docking** at any station gets you its charts: every world and station in the system is found and fully identified, as the home system is. Ships aren't on them; you still have to scan those (`sim/scanner.ts learnSystem`).
- **Until then:** an unscanned contact is an "Unidentified ship", and an unfound one isn't labelled at all.
- **Not for ships:** there's no orbit planning, approach strip milestones or docking for them.

## On screen

- **Marker:** a dot a few pixels across from any distance, cyan in FTL.
- **Engines:** a glow at the tail while it thrusts along its nose (orange; blue in FTL), a smaller one at the nose while it thrusts against it (worked out from its change of velocity, less gravity's share).
- **Model:** within 200 km, a small procedural ship (~60 m: tapered hull, nose cone, cockpit, twin engine pods on pylons, a fin) at its own attitude, lit by the star.
- **Trail (`render/Trail.ts`):** in FTL each ship leaves a trail: the path it actually flew, recorded
  as positions and drawn as a line that fades with age (30 s, `TRAIL_S`) and length (0.2 AU,
  `TRAIL_MAX`).
  - It grows out from where the drive started.
  - It bends where the ship turned, with a sample every 0.5 s and whenever the course turns 0.6°.
  - After drop-out it stays where it was laid and fades there.
  - The first version was one straight line of 30 s at the current speed. It appeared at full
    length the moment FTL started, and swung round with the ship when it turned.
  - Your own ship gets one too, starting just behind the camera. Trails are cleared on arriving
    in a new system.
- **Flash:** a burst that swells and fades over 0.8 s where a ship enters or leaves FTL (`FLASH_S`).
- **Label:** beside any ship the radar has found within 500,000 km: its name once scanned, and its distance (or "FTL") (`Overlay.ts TRAFFIC_LABEL`).
