# Particles and grain fields

`gpu/particles.ts` with `particles.wgsl`, `fields.wgsl` and `sprite.wgsl`. Everything here is
display-referred light, added, and left out of the exposure meter.

## Particles (simulated on the GPU)

A ring of 131,072 particles in a storage buffer. Each frame the layers list emitters (at most 32)
with how many each spawns (fractions carry over, so low rates still spawn now and then); a compute
pass writes the new ones after the last (random direction, speed, size and life per particle), a
second ages and moves all of them and lists the living, and they're drawn with one indirect draw.

- Positions are camera-relative and velocities relative to the frame body (the ship's own frame of
  reference, `ship.vel`), so a particle moves by (its velocity − the ship's) × dt, and drag slows it
  toward the ship's velocity (the local medium; toward the frame body's it flung a belt's plume
  backward along the orbit at ~20 km/s): exhaust left
  behind by a passing ship streams away, the laser's plume stays with the rock you're matched with.
- Sprites are `size` metres across, never under 1.5 px (smaller ones dimmed by their share of a
  pixel), and stretched along their motion relative to the camera over `streak` seconds, their
  light spread along the streak.

| Emitter | Where | Look |
| --- | --- | --- |
| Laser plume | the hit point, a wide cone round the surface's normal | faint ice vapour, ~200/s, 2 s, growing a little (thin, or it hides the rock) |
| Laser sparks | the same | hot orange streaks, ~250/s, 0.4 s |
| Exhaust | other ships' engines while they thrust (normal space, within 60 km) | glowing gas, 1 s, growing |
| Re-entry plasma | a region ahead of the ship, once the air's heating (½ρv³) passes 10⁵ W/m² | streaks pouring past, brighter to 10⁷ |

## Grain fields (made up in the vertex stage)

No buffers: a grain's place is a hash of its index. Up to 8 fields a frame, one draw each.

- **Space dust:** 700 grains in a 3 km box repeating through the system, placed by the ship's
  position (so they hang still as you pass), fading with speed from 3 km/s, gone by 10 km/s, and gone in a world's air (fading out through its upper half) (faster,
  the box is crossed several times a second and the grains read as flickering static).
- **Ring dust:** in a ring's belt, up to 60,000 fine ice grains in a 400 m box that orbits with the
  ring (the box's place advances by the ship's velocity less the orbital velocity there), as dense
  as the ring is at that radius and height, glinting, and glowing when backlit (grains scatter
  forward); and up to 2,500 centimetre pebbles in a 120 m box, bigger the nearer, for depth and
  parallax. Every grain drifts slowly on its own (0.6 m/s dust, 0.25 m/s pebbles), so the belt
  isn't frozen while you sit still.
- **Wreck debris:** 2,500 bits in a 90 m ball round each wreck within 40 km, tumbling so they glint.

## Rain (`gpu/effects.ts rain`)

Snow where the ground is snow (by latitude, from ~0.78 of the way to the pole, as planet.wgsl's polar ice): slow white flakes (1.2 m/s), bigger, brighter, each drifting on its own, with a short smear.

- **When:** under thick cloud on an Earth-like or ocean world, below the cloud base. That's over 85 % of the most cover the world has (0.85 on an Earth-like world, 0.95 on an ocean one), overhead by the cloud map. It's heavier the thicker the cover.
- **What:** a 40 m box of streaks round you falling at 9 m/s, each drawn 0.08 s long, cool grey.
- **How it falls:** the fall is in the field's anchor (the camera's place in the box's repeating space, minus the fall so far, in doubles). The shader's own clock is too coarse at large times to move them smoothly.
- **Grain fields' streak:** fields can draw each grain as a streak back to where it was (`drift.yzw`).
