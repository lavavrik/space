# Shadows

Two kinds, for two scales.

## Across a system: analytic (exact at any distance)

- **Eclipses** (`sim/eclipse.ts`, `gpu/shaders/shadow.wgsl`): the share of the star's disc a point
  sees past the bodies in the way. The star is a disc of angular radius aS, a body one of aO; the
  covered share grows smoothly from first contact (separation aS + aO) to full cover (|aO − aS|),
  where it's (aO / aS)², capped at 1, so a moon smaller than the star leaves an annulus lit and every
  shadow has a penumbra as wide as the star looks from there.
  - On the GPU, each world's uniforms carry the star and up to 4 bodies that can shadow it
    (`occludersOf`: between it and the star, near enough for their shadow cone to reach it). Its
    surface, the air's haze over it, the cloud deck and the sky shell are dimmed by it.
  - On the CPU the same formula lights stations and other ships, and sets the solar panels' output
    (`power.sunlit`; "in the shadow" once more than half the disc is hidden) and the starlight
    heating (sim/thermal.ts).
- **Ring shadows** (`ringShade`): where the sun's ray from a point on the planet crosses the ring
  plane, the ring's opacity there (the same profile the disc is drawn with, `ringband.wgsl`) dims
  it. The planet's shadow on its ring (and on the ring's rocks) was already there (ring.wgsl,
  rock.wgsl `ringShadow`).
- Terrain shadows its own ground: the chunk bake marches toward the sun (terrainBake.wgsl).

## Up close: a shadow map

(Next: ring rocks, ships and stations shadowing each other and the ground near the camera.)
