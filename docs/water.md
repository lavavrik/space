# Water

Seas on Earth-like and ocean worlds (`planet.wgsl`, where `spec` marks water). The water is shaded as a surface that mirrors the sky over its own colour.

## Waves (`waterWaves`)

- **Three octaves of moving noise:** 60, 24 and 9.6 m long, ~3 % of their length high.
  - Each drifts with the wind at deep water's phase speed for its length (√(gλ/2π): ~10, 6 and 4 m/s).
  - Each fades out below a few pixels (by the pixel's footprint, `fw`).
- **Normals:** the slope comes from the noise itself (central differences, 3 more reads per octave). From screen-space derivatives it was as coarse as a pixel quad, and the glints shimmered in moiré.
- **Their clock:** `world.waveO.w` is the time wrapped to an hour. The sim's own clock, ~2.4 million s at day 28, has float32 steps of 0.25 s, and the waves moved in jerks.
- **Coordinates stay small:** the waves are fixed to the world, in its own frame, measured from the camera's place there less a whole number of their common period (3,840 m: 8 × each length, the noise's period). `worlds.ts` writes that origin in doubles (`world.waveO`), so near you the shader adds small numbers to small camera-relative positions. Measured from the world's centre, float32 steps of ~0.5 m would have broken up the 10 m waves.

## Light

- **Fresnel:** 2 % reflected looking straight down, all of it at grazing angles. The water's own colour (by depth, as before) fills the rest.
- **The sky in the water:** the air's own light along the reflected ray, out to the top of the air (`waterSky`, as the sky shell draws it), for each sun, dimmed by their eclipses. A wave's back that would mirror the sea itself is kept just above the horizon. With no air, the water mirrors black space.
- **The suns' glitter** (`waterGlint`):
  - **The lobe:** a normalised Blinn-Phong lobe on the wave normal, × Fresnel at its half vector, × `GLINT_K` (8). The sun's disc is thousands of times brighter than what it lights, so the glints blaze and bloom; at 1 they were pale flecks.
  - **Its sharpness** is cut where the normal varies across a pixel (Toksvig: a lobe narrower than that aliases), and follows how much of the waves' slope is resolved: up close, sharp glints on each wave (exponent 900); far off, where they're sub-pixel, a broad glitter path (40). From orbit, the glint is a soft spot on the sea.
- **Clouds in the water:** where the reflected ray crosses the cloud deck, its cover there, lit as the deck is (from below, greyer the thicker), over the sky. It's a mirrored deck, one lookup: the volumetric clouds' shapes aren't marched again.
- **Shallows:** clear turquoise, fading into the deep's colour by ~25 m, the sandy bottom showing through in the last few metres (by the water's depth in metres, from the terrain under it).
- **Surf:** at the water's edge, under ~2.5 m, a band of white foam broken up by two octaves of noise moving with the wind. It hides the water's mirror where it lies.
- **Ship lamps:** the landing lights and headlights light the water like the ground.
- **Land, ships and stations in the water** (`tonemap.wgsl seaReflect`, screen-space): in the final pass, where a pixel is sea (the water writes alpha 0.5; by the depth's point at the water's radius, the water by a coast missed out, its big far triangles lifted by the land's heights at their corners), the ray mirrored off the flat surface is traced across the screen through the depth buffer: 24 steps growing 1.35× from 1 % of the distance, then halved 5 times onto the surface it went behind. Where it hits, the water mirrors that by Fresnel, smeared up and down as ripples stretch a reflection, fading toward the screen's edges. Where it misses (sky, off screen), or meets the sea itself (a ray skimming the horizon, the world curving down), the water keeps its own sky. Only within 200 km of a sea world. What's off screen can't be mirrored, as with any screen-space reflection.
- **The glint at a coast:** it ends where the land starts (land doesn't mirror the sun); from orbit that edge is sharp.

## Not yet

- Breaking waves rolling in to the shore.
- Spray and swell that move the geometry.
- Night-time city-light reflections.
