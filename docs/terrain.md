# Planet terrain

Rocky, desert, Earth-like, ocean, volcanic and icy worlds have real relief: mountains you can see on the horizon, fly between and land on. Gas and ice giants have none.

## One height function, two implementations

The height is the same noise that paints each world's continents, seas and snow. It's written twice, and the two must match:

| | Where | Used for |
|---|---|---|
| GLSL | `render/shaders/terrain.glsl` (`terrH`, `terrElev`) | raising the terrain mesh, colour, bump shading |
| TypeScript | `sim/terrain.ts` (`terrainH`, `elevationLocal`, `surfaceRadius`) | collisions, landing, altitude readouts, time-warp impact checks |

Both sample the same noise: exact simplex noise for the first 3 octaves (`snoise`, ported line by line; note the float32 `n_` constant, which the GPU rounds differently from a double) and the tiled 64³ gradient-noise texture for the rest (`lib/noise3d.ts`, sampled trilinearly on the CPU as the GPU does). `__tests__/terrain.test.ts` checks the noise stays in range and the peaks stay below the lowest safe orbit.

### Shape

For each octave i, the noise is sampled at `q_i = dir · 1.6 · 2.03^i + O_i`, in the world's own frame (tilted, spinning with `rot`: `worldQuat`).

- **Continents:** fBm, each octave weighing 0.55 of the one before.
- **Mountain ranges:** ridged noise (`(1 − |n|)²`, each octave weighted by the one before so detail gathers on the crests) from octave 3, where octave 2's noise marks a range. Added as `mask · (r − 0.3) · 1.3`.
- **Craters (moons only):** on every other octave from 3 to 13 (~50 km down to ~20 m across on a Moon-sized world). Each lattice cell may hold one (50%), with a random centre, a radius of 0.12–0.35 cells, a flat-floored bowl and a raised rim. Depth is 0.2 of the diameter up to 8 km across, then shallower (∝ √size). They're placed by an integer hash (`mod289i`, `perm289`) that stays exact in float32 and double alike, so the GPU and the physics agree. Floors are darker and rims brighter (`tDet`). They're part of `h`, so they collide, cast shadows and follow the vertex/bump split like everything else.
- **Roughness:** from octave 8 (a few km on an Earth) both gains rise to 0.68, so hills, rocks and gullies keep appearing as you descend. With 0.5 throughout every slope would be about 1%.
- **Elevation (m):** `A · h`, where the amplitude `A = RELIEF[type] × radius`. Worlds with seas use `A · max(0, h − sea)`, so the sea surface sits at the mean radius. Peaks reach about 2.5 A: ~12 km on an Earth-sized world, ~6 km on a Moon-sized rocky one.

### Precision

Up close, even float32 unit directions aren't enough: they resolve ~0.5 m on an Earth, and through the periscope a pixel covers millimetres, so the fine octaves and bump slopes turned to static. On terrain chunks the shaders don't sample `dir · k + O_i`. They use `uQc[i] + (dir − centre) · k`: the chunk centre's lattice point, computed per chunk in double precision (`Terrain.ts latticeAt`), plus the small, precise offset from the centre (`position / R`). The centre point is wrapped by 8 for the noise (the texture's period, `uQn`) and by 2312 = 8 × 289 for the crater hash (`uQc`), so nothing changes but precision (`terrain.glsl terrQ`, `terrQC`).

The GPU's own texture filter also has only 8-bit weights (1/256 of a texel), which at 1000× turned the noise into fine steps that the bump shading showed as moiré. The fragment shader's octaves use `tnoiseHQ` (noise3d.glsl): 8 texel fetches blended at full precision.

The old shader chain `sp = 1.6·dir + seedOffset`, multiplied by 2.03 per octave, lost float32 precision past about 11 octaves. `terrainOffsets` works out each octave's offset `O_i` in double precision. For the texture octaves it wraps the offset into [0, 8), since the texture tiles every 8 cells. That keeps shader coordinates small and precise to 17 octaves, about 15 m features on an Earth.

## Rendering (`render/Terrain.ts`)

- **Baked, not per frame:** evaluating the terrain per vertex per frame (height, 2 more samples for the normal, a 12-step shadow march) and all 17 octaves per pixel cost ~36 ms of GPU on a 2.6K screen landed on a moon. Now each chunk's normals, heights, sun shadows and coarse terrain state (h and the range mask) are baked once into a 66×33 float texture. That's `planet.vert.glsl` with `TERRAIN_BAKE`, drawn as points, one per grid vertex. The shadows are re-baked only when the sun has moved ~0.2° over the chunk (8 chunks a frame at most). Drawing reads the texture, and the fragment shader works out only the octaves finer than the chunk's vertices (`terrHFrom`, ~4 per pixel), continuing from the baked coarse h.

- **Far away:** below `TERRAIN_PX` (200 px apparent radius), or beyond `TERRAIN_NEAR` (10 radii) however big the periscope makes it, a world is the old unit sphere. Its fragment shader bump-maps all the terrain octaves, so relief shows as shading. Its bump mapping and air work from the object-space surface point and the world's centre, not camera-relative world positions: across the system those are ~10¹¹ m, where float32 steps are kilometres (it flashed through the periscope, and chunks positioned from that far did too).
- **Close up:** a cube-sphere quadtree. Each face splits recursively while the camera is within 1.6 chunk edges (quads ~15–20 px on screen), down to about 8 m between vertices.
- **Chunks:** each is a 32×32 grid. Positions are built on the CPU in double precision relative to the chunk centre, and the mesh sits at that centre, so there's no jitter on a 6,000 km world.
- **Vertices:** the vertex shader (`planet.vert.glsl` with `TERRAIN`) raises each vertex by the height, using only the octaves its spacing can show (`uVOct`). Normals come from two nearby height samples.
- **Finer detail:** the fragment shader computes the full height. It bump-maps the octaves the vertices don't have, using screen-space derivatives (Mikkelsen's surface-gradient method). Shading therefore doesn't change when a chunk splits; only the silhouette sharpens.
- **Albedo detail:** colour varies from octave 6 on (`tDet`), about the same contrast at every scale.
- **Skirts** hang from chunk edges to hide cracks between levels.
- **Culling:** chunks past the horizon (allowing for mountains) aren't drawn. At most 12 chunks are built per frame, and ones unused for 240 frames are freed.
- **Shadows:** each terrain vertex marches 12 steps toward the sun over the height field, using up to 9 octaves (mountains and big craters). The steps grow from 2 vertex spacings to 60 relief amplitudes (a 12 km peak's shadow at a 3° sun). The result is a soft shadow term (`vShadow`, the ray's closest clearance against the distance travelled). It's per vertex, so shadows are as sharp as the chunk is detailed, about the same on screen near and far. The far sphere has none.
- **Clouds** are painted on the surface, so they fade out below 25 km (`uCamAlt`) instead of lying on the mountains.

## Physics

- **Collisions:** `flight.ts collide` uses `surfaceRadius` under the ship (+30 m clearance). The contact normal is still radial.
- **Landed:** the ship moves with the ground (`ω × r` from the world's spin) and turns with it during time warp (`timewarp.ts`).
- **Surface frame** (`frame.ts`, 3.): below 30 km over a world with terrain, flight assist and the speed readout work relative to the turning ground. It's blended in from 30 km down to 15 km. Hands off, you hover over one spot instead of the mountains sliding past at the world's spin speed (~100 m/s on a small fast-spinning moon, ~465 m/s at Earth's equator).
- **ALT** on the HUD is height above the ground under you.
- **Surface speed limit** (`flight.ts surfaceLimit`): with flight assist on, speed against the ground is capped at 0.2 × height per second, never below 8 m/s (4 km/s at 20 km, 200 m/s at 1 km). It covers falling as well, so a hands-off or full-thrust dive eases down and touches down at ~8 m/s instead of hitting the ground. Shift triples it. The HUD bar shows it as SURFACE LIMIT.

## City lights (`gpu/shaders/city.wgsl`)

Earth-like worlds are populated: their night side lights up (`city` in the world's uniforms, gpu/worlds.ts, for
`WT.EarthLike`). The lights fade in past the terminator, are dimmed by the air above them like the
ground, and are drawn by the planet shader on both the far sphere and the terrain chunks.

- **Where people live** (`cityPop`): land, not the high ranges or the ice caps, three times as
  crowded along the coasts, in broad settled regions with wilderness between (two noise octaves).
  So the planet shader keeps up to 8 terrain octaves at night on these worlds (3 elsewhere):
  the coastlines are where the lights are.
- **What they look like**, far to near, each layer fading in as its detail grows past a few pixels
  (and left out while it's smaller, which is the filtering): ragged fractal urban areas (fBm), four
  levels of city blobs (~500 km to ~8 km cells) making bright cities with towns round them, a web
  of main roads (ridged noise, ~25 to ~3 km), four levels of scattered specks (~8 km to ~125 m
  cells) that a lit area breaks into, a street grid ~200 m apart turned per district, and sparse
  villages and farms in the countryside. Each layer averages 1 over its own scale (constants from
  Monte Carlo), so the brightness holds as the detail resolves.
- **Brightness**: rolled off at 1.3 (× `CITY_K`), just under where the tone map turns everything
  flat white; above that every city was the same beige disc.
- The look was tuned against a numpy replica of the shader rendering 20 km, 1 km, 250 m and 40 m
  per pixel side by side: much faster than in the game. Cascades of pure blobs looked like polka
  dots up close; noise alone looked like fog; the mix above reads like night photos from orbit.

## Not yet

- Shadows are per vertex: finer relief (bump-mapped) shades itself but casts nothing.
- Contact is radial, so you don't slide down steep slopes.
- Orbits, holds and the planner still measure from the mean radius. They stay above the peaks (`minOrbitAlt` > the highest terrain; tested).

## At night, and your lamps

- **The night's own light:** where the sun's gone, the ground gets a faint bluish ambient
  (starlight, airglow; `planet.wgsl NIGHT_AMB`, 15 % of albedo). The sky glows faintly with as much
  air as the ray crosses (`atmosphere.wgsl`), and the clouds are lit dimly (`vclouds.wgsl`). The
  overcast's dimming of what's behind the clouds (docs/clouds.md) only applies by day. Before, an
  overcast night was pitch black.
- **Your lamps light the ground and the clouds:**
  - The headlights, a cone along the nose, and the landing lights, a wide cone down under the
    hull, a little forward (`frame.wgsl shipLights`).
  - The ground near you is lit by both (terrain only: the far sphere is too far for them to reach).
  - In cloud and fog their light scatters (`shipLightAt`): beams in the murk.
- **Landing lights (`sim/landingLights.ts`):** they switch themselves on under 2 km above the
  ground when it's dark there (the sun 5° under the horizon, or thick cover overhead while under
  the deck), and off again when it's light or you climb (with a margin, so they don't flicker).
  They draw 1.2 kW and say "Landing lights on/off" when they switch.
- The star's lens flare is off while a world hides the star: it reads the frame at the star, and
  there the ground lit by the landing lights flared.

## Landed

- The nose goes no lower than the horizon while you're on the ground: past it, it's turned back up
  and the pitch stops (`sim/update.ts`).
- Under time warp a landed ship turns with the world (`sim/timewarp.ts railsStep`). Its velocity now
  turns with it too, matching the ground where it is. Before, it kept its old heading, and back at
  ×1 the ship slid off the turned ground and flew up ~80 m.
- Relief on worlds with air is ~40 % more than it was (`RELIEF`): Earth-like 0.0011 of the
  radius, ocean 0.00085, desert 0.0015. Scaling it leaves the coasts where they were.
