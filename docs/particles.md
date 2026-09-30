# Particles and grain fields

`gpu/particles.ts` with `particles.wgsl`, `fields.wgsl` and `sprite.wgsl`. Everything here is
display-referred light, added, and left out of the exposure meter.

## Particles (simulated on the GPU)

A ring of 131,072 particles in a storage buffer. Each frame the layers list emitters (at most 32)
with how many each spawns (fractions carry over, so low rates still spawn now and then); a compute
pass writes the new ones after the last (random direction, speed, size and life per particle), a
second ages and moves all of them and lists the living, and they're drawn with one indirect draw.

- Positions are camera-relative and velocities relative to the frame body (the ship's own frame of
  reference, `ship.vel`), so a particle moves by (its velocity − the ship's) × dt: exhaust left
  behind by a passing ship streams away, the laser's plume stays with the rock you're matched with.
- Sprites are `size` metres across, never under 1.5 px (smaller ones dimmed by their share of a
  pixel), and stretched along their motion relative to the camera over `streak` seconds, their
  light spread along the streak.

| Emitter | Where | Look |
| --- | --- | --- |
| Laser plume | the hit point, along the surface's normal | ice vapour, ~600/s, 2.5 s, growing |
| Laser sparks | the same | hot orange streaks, ~250/s, 0.4 s |
| Exhaust | other ships' engines while they thrust (normal space, within 60 km) | glowing gas, 1 s, growing |
| Re-entry plasma | a region ahead of the ship, once the air's heating (½ρv³) passes 10⁵ W/m² | streaks pouring past, brighter to 10⁷ |

## Grain fields (made up in the vertex stage)

No buffers: a grain's place is a hash of its index. Up to 8 fields a frame, one draw each.

- **Space dust:** 700 grains in a 3 km box repeating through the system, placed by the ship's
  position (so they hang still as you pass), fading with speed from 3 km/s, gone by 10 km/s (faster,
  the box is crossed several times a second and the grains read as flickering static).
- **Ring dust:** in a ring's belt, up to 60,000 fine ice grains in a 400 m box that orbits with the
  ring (the box's place advances by the ship's velocity less the orbital velocity there), as dense
  as the ring is at that radius and height, glinting, and glowing when backlit (grains scatter
  forward); and up to 2,500 centimetre pebbles in a 120 m box, bigger the nearer, for depth and
  parallax. Every grain drifts slowly on its own (0.6 m/s dust, 0.25 m/s pebbles), so the belt
  isn't frozen while you sit still.
- **Wreck debris:** 2,500 bits in a 90 m ball round each wreck within 40 km, tumbling so they glint.
