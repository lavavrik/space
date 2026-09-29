# Sound

All synthesised with Web Audio: no sound files (`src/game/audio/`). Space is silent, so everything is
what the pilot hears inside the hull.

- **`levels.ts`** (pure, tested): reads the game each frame into continuous levels (0–1) and, by
  comparing with the last frame, one-shot cues.
- **`ShipAudio.ts`**: a graph of always-running layers (oscillators and looped noise through
  filters), steered by gain and filter frequency with `setTargetAtTime`, and one-shot voices for the
  cues. It uses a compressor on the master, so stacked layers don't clip.
- Browsers only allow audio after a gesture, so the graph is built on the first click or key press.
  It suspends while the tab is hidden. **Shift+P** turns sound off and on (kept in `localStorage`).

## Layers

| Layer | When | Sound |
|---|---|---|
| hum | alive | 50/100 Hz and quiet fans (life support) |
| idle | normal space, flying (not docked, landed or in FTL) | the drive's warbling hum: two saws through a resonant low-pass whose cutoff wobbles at 5.5 Hz, with a slow pitch warble. It's a nod to a certain cartoon delivery ship, and louder and higher as you thrust. |
| engine | linear thrust (`thrustKW − turnKW`, full at 400 m/s²) | deep brown-noise rumble with detuned 38 Hz saws; the filter opens with thrust |
| rcs | turning (`power.turnKW`, from `turnThrust`) | band-passed hiss |
| ftlCharge | FTL charging | a whine up 2.5 octaves over the charge, with a quickening tremolo |
| ftl | in FTL | detuned pair (beating) over a hollow roar; pitch rises with log speed (c → 2000 c) |
| jumpCharge / jump | hyperdrive charge / departure and tunnel | a swelling chord / a roar |
| wind | in an atmosphere | noise band; loudness with dynamic pressure (log, full ≈ 50 kPa), pitch with airspeed |
| laser / cutting | laser firing / cutting rock | buzzing power stage / crackle |
| grit | belt dust eroding the hull | fine high patter |

## Cues

Docking granted (two-note chime), docked (clunk and a rising triad), launch (clunk and hiss), catapult
(a heavy thud and a long whoosh). FTL in and out (a whoosh and a pitch glide). Radar sweep (a ping).
Target selected (a tick). A hit (a thud sized by the hull lost in the frame; wear under 0.2 % per frame
makes no sound). Ship lost (a boom). Messages: warnings get a two-tone beep, FTL messages a soft tone,
and others a tick. A message only sounds when no louder cue fires that frame, and the same line
within 2 s stays quiet. Collision radar: a fast pip while a rock is on a collision course.
