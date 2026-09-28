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

The old shader chain `sp = 1.6·dir + seedOffset`, multiplied by 2.03 per octave, lost float32 precision past about 11 octaves. `terrainOffsets` works out each octave's offset `O_i` in double precision. For the texture octaves it wraps the offset into [0, 8), since the texture tiles every 8 cells. That keeps shader coordinates small and precise to 17 octaves, about 15 m features on an Earth.

## Rendering (`render/Terrain.ts`)

- **Baked, not per frame:** evaluating the terrain per vertex per frame (height, 2 more samples for the normal, a 12-step shadow march) and all 17 octaves per pixel cost ~36 ms of GPU on a 2.6K screen landed on a moon. Now each chunk's normals, heights, sun shadows and coarse terrain state (h and the range mask) are baked once into a 66×33 float texture. That's `planet.vert.glsl` with `TERRAIN_BAKE`, drawn as points, one per grid vertex. The shadows are re-baked only when the sun has moved ~0.2° over the chunk (8 chunks a frame at most). Drawing reads the texture, and the fragment shader works out only the octaves finer than the chunk's vertices (`terrHFrom`, ~4 per pixel), continuing from the baked coarse h.

- **Far away:** below `TERRAIN_PX` (200 px apparent radius) a world is the old unit sphere. Its fragment shader bump-maps all the terrain octaves, so relief shows as shading.
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

## Not yet

- Shadows are per vertex: finer relief (bump-mapped) shades itself but casts nothing.
- Contact is radial, so you don't slide down steep slopes.
- Orbits, holds and the planner still measure from the mean radius. They stay above the peaks (`minOrbitAlt` > the highest terrain; tested).
