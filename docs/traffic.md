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

## On screen

- **Marker:** a dot a few pixels across from any distance, cyan in FTL.
- **Engine glow:** behind the ship while it manoeuvres, orange in normal space and blue in FTL.
- **Model:** within 200 km, a small procedural ship (~60 m: tapered hull, nose cone, cockpit, twin engine pods on pylons, a fin), pointing where it's going and lit by the star.
- **Trail:** in FTL a trail streams behind each ship: a line along its motion, as long as 30 s of travel at its current speed (`TRAIL_S`), capped at 0.5 AU (`TRAIL_MAX`). It's bright at the ship and fades to nothing at the tail, grows as the ship speeds up, and pulls back in after it drops out (eased, `TRAIL_EASE`). Your own ship gets the same trail in FTL, streaming back along your course.
- **Flash:** a burst that swells and fades over 0.8 s where a ship enters or leaves FTL (`FLASH_S`).
- **Label:** kind, name and distance (or "FTL") beside any ship within 500,000 km (`Overlay.ts TRAFFIC_LABEL`).
