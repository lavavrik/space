# Saving

The game saves itself (`game/save.ts`) and picks up where you left off when you open it again. There's one save, kept in the browser's `localStorage` under `farlight.save`.

## When

- every 15 s of real time (`AUTOSAVE_S`);
- whenever the page is hidden or closed (tab switch, reload, quitting the browser: `visibilitychange` and `pagehide`).

The controls panel (Tab) shows when it last saved and has a **New game** button. Click it twice within 4 s: the save is deleted and you start over at home.

A lost ship isn't saved (the last save stands). If the browser won't store anything (private mode, storage full), the game just runs without saving.

## What's saved

The universe comes from seeds, so a save holds only what you changed:

| | |
|---|---|
| **Where and when** | the system (by id), the sim clock. Every world's orbit and spin and every station's follow from the clock, which is why world spin is now worked out from it (`sim/kepler.ts updateBodies`) instead of added up frame by frame. |
| **The ship** | position and velocity relative to its frame body (by name), attitude, normal space or FTL (speed, throttle, cruise, course), flight assist, decoupled, sun tracking, tanks, battery, hull temperature, venting, landed on, fitted battery, modules and radiators, fitted computers (by catalog id) |
| **What it's doing** | docked (station, pad), a docking request, the docking computer (phase, station, pad), the station frame, the autopilot (body, orbit type, station, radius, plane, hold point, phase, settled). A drive that was charging goes back to insertion and charges again. |
| **A hyperjump** | in transit, it's saved as its destination: on load you arrive there. While it's still charging, it isn't saved (you're back where you were). |
| **What you know** | scan progress, radar contacts, the target (a world or station), a selected star, nav waypoints, the final stop and the route mode |
| **Settings** | headlights, orbit preview, radar window |

Not saved: other ships (they're spawned afresh), a running nav route (its waypoints are kept; engage it again from the nav panel, M), a tanker on its way, the orbit planner, a scan in progress, time warp.

## Format and versions

JSON, with a version number (`SAVE_VERSION`). A save of another version, or one naming a system, world or station this universe doesn't have, is ignored and a new game starts (it logs why). Objects are stored by name or id, never by reference: bodies and stations by name within the system, systems by id (`universe/galaxy.ts systemById`), modules and computers by catalog id.
