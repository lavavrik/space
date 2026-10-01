# Planet terrain

Rocky, desert, Earth-like, ocean, volcanic and icy worlds have real relief: mountains you can see on the horizon, fly between and land on. Gas and ice giants have none.

## One height function, two implementations

The height is the same noise that paints each world's continents, seas and snow. It's written twice, and the two must match:

| | Where | Used for |
|---|---|---|
| GLSL | `render/shaders/terrain.glsl` (`terrH`, `terrElev`) | raising the terrain mesh, colour, bump shading |
| TypeScript | `sim/terrain.ts` (`terrainH`, `elevationLocal`, `surfaceRadius`) | collisions, landing, altitude readouts, time-warp impact checks |

Both sample the same noise: exact simplex noise for the first 3 octaves (`snoise`, ported line by line; note the float32 `n_` constant, which the GPU rounds differently from a double) and the tiled 64³ gradient-noise texture for the rest (`lib/noise3d.ts`).

**The texture's noise exactly** (`noise3d.wgsl gnoise`, `lib/noise3d.ts gnoise`): the texture holds gradient noise (512 gradients on an 8³ lattice, quintic between them), and its linear filter puts a kink in the slope at every texel face, axis-aligned planes that crossed the terrain as straight lines: a grid of odd-shaped cells, seen from any height (with the ridges' sharp crests, creases everywhere). The terrain bake (`terrainBake.wgsl`, `tExact`), which near the ground carries every octave in the mesh, and the CPU (`sim/terrain.ts`) work the noise out exactly from the lattice's gradients (an 8³ rgba32 texture, `world.wgsl gradTex`): 8 reads and a quintic blend, smooth. It matches the texture to ~0.007 (its values span ~±0.35). The fragment shader's octaves magnified past ~3 px a texel use it too; finer ones keep the one-tap filter, where a kink is under a pixel. The bake pass went from ~0.2 to ~0.26 ms on the frames it builds chunks (RTX 4090). `?tdbg=8388608`: the texture as before. `__tests__/terrain.test.ts` checks the noise stays in range and the peaks stay below the lowest safe orbit.

### Shape

For each octave i, the noise is sampled at `q_i = dir · 1.6 · 2.03^i + O_i`, in the world's own frame (tilted, spinning with `rot`: `worldQuat`).

- **Continents:** fBm, each octave weighing 0.55 of the one before.
- **Mountain ranges:** ridged noise (`(1 − |n|)²`, each octave weighted by the one before so detail gathers on the crests) from octave 3, where octave 2's noise marks a range. Added as `mask · (r − 0.3) · 1.3`.
  - **Rounded crests** (`terrain.wgsl ridgeAbs`, `RIDGE_ROUND` 0.15): within ±0.15 of zero |n| is `n²/2r + (r/2)·smoothstep(0, r, |n|)`, 0 on the crest and |n| from 0.15 on, smooth between. The noise texture is interpolated linearly between its texels, so its zero crossings are straight within each one, and the sharp `|n|` made every crest (and the next octave's weight along it) a straight dark crease tens of metres long, in every direction, seen from any height. (A plain parabola, `n²/2r + r/2`, lowered every crest and with it the next octave's weight: ranges kilometres lower.)
- **Craters (moons only):** on every other octave from 3 to 13 (~50 km down to ~20 m across on a Moon-sized world). Each lattice cell may hold one (50%), with a random centre, a radius of 0.12–0.35 cells, a flat-floored bowl and a raised rim. Depth is 0.2 of the diameter up to 8 km across, then shallower (∝ √size). They're placed by an integer hash (`mod289i`, `perm289`) that stays exact in float32 and double alike, so the GPU and the physics agree. Floors are darker and rims brighter (`tDet`). They're part of `h`, so they collide, cast shadows and follow the vertex/bump split like everything else.
- **Roughness:** from octave 8 (a few km on an Earth) both gains rise to 0.6, so hills, rocks and gullies keep appearing as you descend. With 0.5 throughout every slope would be about 1%. (At 0.68 each finer octave was steeper than the last, ×1.38 the slope an octave, and the finest, tens of metres across, made the ground lumpy everywhere: now ×1.22, ~30 % less height change over 40 m, the heights' spread over the world the same to 2 %. `?tdbg=8388608` shows the old shape, on the GPU only.)
- **Elevation (m):** `A · h`, where the amplitude `A = RELIEF[type] × radius`. Worlds with seas use `A · max(0, h − sea)`, so the sea surface sits at the mean radius. Peaks reach about 2.5 A: ~12 km on an Earth-sized world, ~6 km on a Moon-sized rocky one.

### Precision

Up close, even float32 unit directions aren't enough: they resolve ~0.5 m on an Earth, and through the periscope a pixel covers millimetres, so the fine octaves and bump slopes turned to static. On terrain chunks the shaders don't sample `dir · k + O_i`. They use `uQc[i] + (dir − centre) · k`: the chunk centre's lattice point, computed per chunk in double precision (`Terrain.ts latticeAt`), plus the small, precise offset from the centre (`position / R`). The centre point is wrapped by 8 for the noise (the texture's period, `uQn`) and by 2312 = 8 × 289 for the crater hash (`uQc`), so nothing changes but precision (`terrain.glsl terrQ`, `terrQC`).

The GPU's own texture filter also has only 8-bit weights (1/256 of a texel), which at 1000× turned the noise into fine steps that the bump shading showed as moiré. The fragment shader's octaves used `tnoiseHQ` (noise3d.glsl): 8 texel fetches blended at full precision; now `gnoise`, the noise itself (above).

The old shader chain `sp = 1.6·dir + seedOffset`, multiplied by 2.03 per octave, lost float32 precision past about 11 octaves. `terrainOffsets` works out each octave's offset `O_i` in double precision. For the texture octaves it wraps the offset into [0, 8), since the texture tiles every 8 cells. That keeps shader coordinates small and precise to 17 octaves, about 15 m features on an Earth.

## Rendering (`render/Terrain.ts`)

- **Baked, not per frame:** evaluating the terrain per vertex per frame (height, 2 more samples for the normal, a 12-step shadow march) and all 17 octaves per pixel cost ~36 ms of GPU on a 2.6K screen landed on a moon. Now each chunk's normals, heights, sun shadows and coarse terrain state (h and the range mask) are baked once into a 66×33 float texture. That's `planet.vert.glsl` with `TERRAIN_BAKE`, drawn as points, one per grid vertex. The shadows are re-baked only when the sun has moved ~0.2° over the chunk (8 chunks a frame at most). Drawing reads the texture, and the fragment shader works out only the octaves finer than the chunk's vertices (`terrHFrom`, ~4 per pixel), continuing from the baked coarse h.

- **Far away:** below `TERRAIN_PX` (200 px apparent radius), or beyond `TERRAIN_NEAR` (10 radii) however big the periscope makes it, a world is the old unit sphere. Its fragment shader bump-maps all the terrain octaves, so relief shows as shading. Its bump mapping and air work from the object-space surface point and the world's centre, not camera-relative world positions: across the system those are ~10¹¹ m, where float32 steps are kilometres (it flashed through the periscope, and chunks positioned from that far did too).
- **Close up:** a cube-sphere quadtree. Each face splits recursively while a chunk's quads would be over 6 CSS px on screen, by the view's own resolution (so the periscope counts), down to about 8 m between vertices.
  - By distance alone (within 1.6 chunk edges) the quads were 15–20 px wherever you looked, and on a big screen the far ground and the mountains' silhouette against the sky read as low-res.
  - With more than 900 chunks the threshold eases up (to 20 px at most) and comes back down when there's room. Through the periscope it is also scaled at once by the magnification^0.65. At a fixed 20 px cap, 100× split everything in view to the finest level: ~4,500 chunks, the frame rate halved. Eased there by the budget alone, it took seconds to come back down zooming out, the ground round you in huge chunks meanwhile, their skirts as ribbons. The perf overlay's second line shows the terrain's state: chunks drawn and held, built and baked a frame, the threshold.
  - Up to 24 chunks are built a frame.
  - A chunk's distance is measured from the ground at its centre (its height cached per chunk, octaves down to about its size), not from the sphere's radius. On a highland 7.5 km up, the ground beside you counted as 7.5 km away and stayed at 46 m between vertices. Only the periscope refined it, and when zooming tightened the budget, hills 100 m away merged away.
  - The horizon for culling allows for the ground reaching ~1.3 × the relief both ways: past the lowest ground, and up to the highest peaks. From the ground, it had cut off mountains ~360 km out. A big coarse chunk across the line still drew them; zoomed in and split finer, they vanished.
  - The fragment shader's octaves aren't capped by the world's apparent size when chunks are drawn (landed that allowed ~9, i.e. nothing finer than ~50 km beyond the vertices, until the periscope raised it); its own derivatives decide.
  - Zooming the periscope made the LOD flicker. The fixes that keep it steady:
    - only chunks inside the zoomed view use its resolution; the rest use the unzoomed one, so a zoom doesn't split the whole world;
    - a split chunk merges only once its quads fall under 0.7× the threshold (hysteresis);
    - the budget eases slowly (×1.03 up, ÷1.01 down), with a band where it rests;
    - split chunks are marked in use, so their children's parents aren't freed and rebuilt;
    - when a split can't finish this frame, it falls back to the chunk if it already exists, and never builds a coarse one to stand in.
- **Chunks:** each is a 32×32 grid. Positions are built on the CPU in double precision relative to the chunk centre, and the mesh sits at that centre, so there's no jitter on a 6,000 km world.
- **Uploads:** each chunk's transform changes every frame. It has a fixed slot in one buffer per world (`chunk.wgsl chunkModels`), written in a single upload. A separate write per chunk, ~1,100 a frame landed, was the bulk of the frame's driver calls. Under D3D12 (Windows) each call costs far more than on Metal.
- **Pooling:** a freed chunk's buffers, bind groups and slot go to a pool (up to 512) for the next chunk built, instead of being destroyed and created again. Zooming built and freed ~100 buffers a frame.
- **Large-scale colour terms, baked per vertex:** the land's moisture (its two big octaves, 500+ km across) and the colour patches' first three octaves (300+ km) are slow simplex noise, so a chunk's vertices carry them (`terrainBake.wgsl`, a third vec4 a vertex; `terrain.wgsl moist12`, `h2Base`) and its pixels interpolate; the finer octaves stay per pixel. Moisture is evaluated once a pixel (the climate and the lakes both read it), not twice. The far sphere still computes them per pixel.
- **Fragment cost:** the noise's own 8-tap filter (precise where a texel spans pixels; the GPU's has 8-bit weights, which showed as blocks) runs only on octaves magnified past ~3 px a texel. The finer ones use the GPU's one-tap filter. Every octave ran the 8 taps, ~80 texture reads a pixel zoomed in: the terrain's whole cost at 100×. Open sea skips the fine octaves altogether, when the coarse height plus the most they could add is still under the sea (`terrain.wgsl terrRise`).
- **CPU:** walking the quadtree costs ~6 ms per frame landed on an M5 Pro, and encoding ~900 chunk draws ~2.4 ms. Both are candidates if the CPU turns out to be what limits the frame.
- **Vertices:** the vertex shader (`planet.vert.glsl` with `TERRAIN`) raises each vertex by the height, using only the octaves its spacing can show (`uVOct`). Normals come from two nearby height samples.
- **Finer detail:** the fragment shader computes the full height. It bump-maps the octaves the vertices don't have, using screen-space derivatives (Mikkelsen's surface-gradient method). Shading therefore doesn't change when a chunk splits; only the silhouette sharpens.
- **Albedo detail:** colour varies from octave 6 on (`tDet`), about the same contrast at every scale.
- **The ground up close** (`planet.wgsl groundDetail`): what the octaves can't give a metre-scale view.
  - **Patches** of soil and growth at 48 and 9.6 m: brightness, drier or greener.
  - **Bare rock** where the ground itself is steep. By the bumps' slope it was rock everywhere.
  - **Stones**, dark and scattered, at 2.4 and 0.6 m.
  - **Fine grain** at the same scales, and **small bumps** that catch the light (their slope from the noise, as the water's waves).
  - Each layer fades in over a few pixels. Coordinates are the waves' near-camera frame (`world.waveO`), so they stay precise at a metre on a 6,000 km world.
- **Skirts** hang from chunk edges to hide cracks between levels.
- **Culling:** chunks past the horizon (allowing for mountains) aren't drawn. At most 12 chunks are built per frame, and ones unused for 240 frames are freed.
- **Shadows:** each terrain vertex marches 12 steps toward the sun over the height field, using up to 9 octaves (mountains and big craters). The steps grow from 2 vertex spacings to 60 relief amplitudes (a 12 km peak's shadow at a 3° sun). The result is a soft shadow term (`vShadow`, the ray's closest clearance against the distance travelled). It's per vertex, so shadows are as sharp as the chunk is detailed, about the same on screen near and far. The far sphere has none.
- **Clouds** are painted on the surface, so they fade out below 25 km (`uCamAlt`) instead of lying on the mountains.

## Cities by day (`city.wgsl cityDay`), and their closed airspace (`sim/airspace.ts`)

The night's city lights are built in layers (`cityDensity`): the population, an urban intensity (its fBm: the broad cores), and four layers of towns and cities on it (blobs, ~1 to ~100 km); the lights then add districts' specks, highways, a street grid and villages. By day the same layers are the built city, so the lit city is the built one:

- **Cover:** the towns' density itself (`CITY_C0`–`CITY_C1`), and villages where the districts' specks lift it (the lights' density with the specks, alone, was ~7 % of the towns' away from a speck: by day the cities were scattered dots). Only the two coarse speck layers: the finer two are spots under a block.
- **Blocks:** the lights' own street grid (~126 m, each district of 12 × 12 turned its own way), streets where the street lamps are, roofs varied by block (grey to beige, some dark tar and white sheds, a few districts of red tile: more, and a city went pink under the haze), parks more toward the edges, each block a little darker along its streets. **Each block built or not** by the density at its middle (carried there from the pixel by the density's screen derivatives, exact on the interpolated value), so towns end raggedly, a block at a time; by the density at each pixel every town and village was a disc cut out of the grid.
- **Highways:** the lights' two coarser road octaves as dark lines, out into the country.
- **Baked:** the population and the towns' density per vertex (`terrainBake.wgsl`, bake slot 2's z and w): smooth over a km or more. Per pixel every land pixel ran 10 noise octaves and the towns' four layers of hashed spots: terrain 1–2 → 7.4 ms over a populated world (RTX 4090, 3132 × 1597). Now +0.6 ms there. Not on the far sphere: its cities are under a pixel by day (its night lights as before).
- Nothing's in 3D. **The airspace over the cities is closed below 3 km** (`sim/airspace.ts`): the CPU works out the towns' density the same way (the population, the fBm, the four blob layers, and the shader's integer hash in 32-bit arithmetic; `__tests__/airspace.test.ts` holds the GPU's own hash outputs), and the floor rises over the ground from just outside a town's cover (density 0.04–0.08) to 3 km. Lone villages stay open. Coming down within 1.5 km of it, a warning pill (`RESTRICTED AIRSPACE BELOW 3,000 m`); under it, a message once, no descending at all (a wall: with boost the pilot outpushed a softer one), a climb back (0.15 × how far under, 15–150 m/s) and the way across braked (or you could skim in under a town's edge), with propellant as any thrust. Not while landed or auto-docking (sky stations are 10–20 km up). Measured against the shader: at density ≥ 0.25 the GPU's centre pixels are 100 % built, at 0.12 most, in the edge band block by block.

## Climate (`planet.wgsl landClimate`)

On Earth-like and ocean worlds' land, the cover follows how warm and how wet it is, blended over the world's palette (two thirds, less on the highest ground), so each world keeps its own character:

- **Warmth** falls with latitude and height (`landTemp`).
- **Wetness** (`landMoist`): continents' climates ~2,500 km across, regions ~500 km, patches ~100 km (by the first alone a view from the ground was one cover to the horizon); less in dry belts ~25–35° from the equator (where the air sinks: the deserts); more near the coasts.
- **The cover:** desert, steppe, grassland where it's dry; savanna, forest, jungle where it's wet; tundra and taiga where it's cold. Snow where it's cold enough as well as high enough.
- **Lakes:** in low, wet ground, their outlines from the noise alone (the height and wetness only nudge its threshold: gated by the height directly, on a wide flat plain a lake's edge followed tiny differences in it, and neighbouring terrain chunks, which have them, cut it along their straight edges: SPACE-78), small (tens of km at most), still water in the sea's colour a few tens of metres down, reflecting as the sea does. The geometry is the land's there, so only where it's low and flat. (Darker than the sea, the first ones stood out from orbit as dark blue patches.)
- Not yet: rivers (a heightfield shader has no flow to follow).

## Valley fog at dawn (`planet.wgsl`)

On Earth-like and ocean worlds, low fog lies over the ground where the sun's rising (it's in the east, from just under the horizon to ~17° up, burning off as it climbs): in valleys, under the region's own height (the cloud cube's coarse ground height, ~100 km across) plus up to 190 m, and over low ground under 50–200 m (the coastal plains' morning fog), in patches tens of km across. How much hides the ground is its thickness along the line of sight (from above, its depth over the slant; from inside it, the distance). Its top is lit by the low sun through the air even where the valley floor's in the hills' shadow (lit as the ground was, it made dark blue pools). Hilltops stand out of it. Applied before the haze.

## Moonlight and planetshine (`gpu/worlds.ts shineOf`, `planet.wgsl`)

Each world's night has one more light: its parent planet for a moon (planetshine), its largest moon for a planet (moonlight), as a directional light from that body. Its brightness against the sun: the body's albedo × its size from here squared × how much of its sunlit side faces this way (a Lambert sphere's phase), then squashed as eyes adapting to the dark see it (∛ × 3, at most 0.3): a full moon's 2.5e-6 of sunlight comes to ~0.04, a full planet on its moon ~0.13. At their real levels both were invisible.

## Snow and rain (`planet.wgsl`)

- **Snow in shade** is lit by the blue sky alone: the sky's light on it is bluer (0.72, 0.88, 1.25 × by how much is snow).
- **Snow sparkles:** tiny ice facets catching the sun, ~25 cm apart in the near-camera frame (`world.waveO`, precise), the noise read shifting with the view so they twinkle as you move, only where they're over a pixel.
- **Ground detail on snow:** mostly not (its stones and soil patches read as dark spots scattered over it).
- **Wet ground** where it's raining (the cover overhead near its most, as the rain itself): darker by up to 35 %, as soaked soil and rock are. Not on snow.

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

- **The sky's light by day:** the ground gets the sky's own light, 15 % of albedo at full, by the sun's height over it (rising from 9° below the horizon to 14° above: dawn and dusk aren't dark), bluish, and as much again from a pair's second sun in its colour (`planet.wgsl`). At 7 % by the lit side of the ground alone, the land under a low sun stayed dark.
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
