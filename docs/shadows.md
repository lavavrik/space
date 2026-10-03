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

## Up close: a shadow map (`gpu/shadowmap.ts`)

Three cascades round the camera (half-widths 300 m, 3 km, 30 km; 2048² each, one depth texture
array), each an orthographic view from the star, drawn while something near can cast (rocks out,
another ship, a station within 30 km).

- **Casters:** ring rocks and trojan swarm rocks (every rock's own shape, from a coarse icosphere: a shadow needs only its
  outline; into a cascade only if its layer's band starts inside it and its biggest rocks are a few
  texels across), other ships' hulls, station hulls and sky stations. Their `vsShadow` stages read
  the cascade's matrix from group 0 (frame.wgsl `Caster`).
- **Receivers** (frame.wgsl `shadowAt`): rocks, ships, station hulls, sky stations, and terrain up
  close. The cascade by distance, a normal offset of 1.5 texels and a small depth bias against
  acne, 3 × 3 PCF for soft edges, faded out toward the last cascade's edge.
- **Culling:** the rock cull (rocksCull.wgsl) keeps a rock that's out of view if its shadow may fall
  into view (checked at the middle and end of ~40 of its sizes along the sun's ray).
- **Cost** (Apple M-series, 2400 × 1500, inside a ring): about 1 ms per cascade. Ideas if it matters:
  re-draw the far cascades every other frame, or a per-cascade cull.
- A sky station's shadow on the ground only shows with the sun high: at a 10° sun it falls ~60 km
  away, past the cascades.
