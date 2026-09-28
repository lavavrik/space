# Traffic

Other ships go about their business in each system (`sim/traffic.ts`, drawn by `render/Traffic.ts`). There are 3 + 2 per station of them, at most 12, with a kind (freighter, courier, tanker…) and a name, the same every time you visit a system.

## What they do

They don't fly with the player's physics. Each follows a scripted cycle between destinations (stations and worlds, not stars), worked out from the sim clock and the bodies' current positions. Time warp simply runs it faster.

| Phase | What happens |
|---|---|
| **linger** | hangs 2–6 km off a station, or circles a world in a low orbit at the real orbital rate, for 70–180 s |
| **depart** | pulls away toward the next destination, speeding up at 150 m/s² for 12 s |
| **ftl** | crosses to it on a straight line, speed easing up and back down (smootherstep). The leg takes 20 s + 25 s × log₁₀(1 + d / 10,000 km): ~20 s next door, ~2 min across an AU. It ends outside the destination's FTL limit (60 km off a station). |
| **arrive** | slows from the drop point into its linger spot at the destination over 12 s |

They don't collide, dock, answer hails, or use the entry corridors yet.

## Radar, targeting and scanning

Ships are targets like bodies and stations (`types.ts Npc`, kind `ship`).

- **Radar:** a sweep picks them up within its range (as "ship" contacts), and they stay tracked as they move.
- **Selecting:** you can pick one with T, G, a click or the radar window. The selected ship gets a cyan triangle (bodies get circles, stations squares), a scan arc while it's being scanned, and an edge arrow when it's off screen.
- **Scanning** (Y; a 60 m ship resolves at ~60,000 km with the best scanner):

| Scanned | Reveals |
|---|---|
| 25 % | class and name ("Hauler Meridian") |
| 50 % | what it's doing (holding near, leaving, in FTL, arriving at) |
| 75 % | where it's bound |

  The info panel (I) shows these rows plus your distance and relative speed. Your home system's ships aren't known in advance; you have to find them.
- **Until then:** an unscanned contact is an "Unidentified ship", and an unfound one isn't labelled at all.
- **Not for ships:** there's no orbit planning, approach strip milestones or docking for them.

## On screen

- **Marker:** a dot a few pixels across from any distance, cyan in FTL.
- **Engine glow:** behind the ship while it manoeuvres, orange in normal space and blue in FTL.
- **Model:** within 200 km, a small procedural ship (~60 m: tapered hull, nose cone, cockpit, twin engine pods on pylons, a fin), pointing where it's going and lit by the star.
- **Trail:** in FTL a trail streams behind each ship: a line along its motion, as long as 30 s of travel at its current speed (`TRAIL_S`), capped at 0.5 AU (`TRAIL_MAX`). It's bright at the ship and fades to nothing at the tail, grows as the ship speeds up, and pulls back in after it drops out (eased, `TRAIL_EASE`). Your own ship gets the same trail in FTL, streaming back along your course.
- **Flash:** a burst that swells and fades over 0.8 s where a ship enters or leaves FTL (`FLASH_S`).
- **Label:** beside any ship the radar has found within 500,000 km: its name once scanned, and its distance (or "FTL") (`Overlay.ts TRAFFIC_LABEL`).
