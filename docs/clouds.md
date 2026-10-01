# Clouds

Earth-like and ocean worlds have a cloud deck. Its pattern is one per world, baked once into a
cube map in the world's own frame (`cloudBake.wgsl`, from `clouds.wgsl cloudRaw`), and used three
ways:

- **From afar: a flat deck** (`cloudLayer.wgsl`): a shell at the deck's height (1.3 scale heights),
  its cover from the cube plus finer noise octaves, lit and hazed like the ground. The cover is
  shaped as the volumetric clouds' is (`clouds.wgsl weatherCover`: a system's heart a sheet, its
  thinner edges broken into clumps), then eroded, so each clump is opaque with a crisp edge; where
  clumps or billows are under a pixel they average out. Taken plainly as an opacity, thin cover was
  a faint veil spread wide, and the systems faded out at their edges.
- **Their shadows on the ground** (`planet.wgsl`): the cover where the sun's ray from a surface
  point crosses the deck.
- **Up close: volumetric clouds** (`vclouds.wgsl`, `gpu/vclouds.ts`), for the nearest clouded world
  within 8 deck heights, fading in from 8 to 4 deck heights while the flat deck fades out
  (`world.deckHide`).

## The volumetric clouds

A compute pass after the scene, at half the frame's resolution (at most 0.4 MP), marches each
pixel's ray through the cloud layer (0.4 to 1.05 deck heights up) in 48 steps, stopping at the
scene's depth (so mountains and stations poke through) or 250 km out. The tone map lays the result
over the frame (scene × what the clouds let through + their light) in their own pass on the resolved
frame. The particles (plasma, exhaust, dust) are drawn after that, over them, depth-tested by hand
against the scene: drawn in the scene, the clouds went over them too, and plasma streaming past the
hull showed dimly, as if beyond the clouds. Bloom and the lens flare see the clouds.

- **Cover:** Earth-like and ocean worlds are clouded over most of their face (`clouds.wgsl
  cloudCover`: from a raw −0.2, not 0.02 as the others), with clear stretches between systems;
  `sim/clouds.ts` is the same function on the CPU (the debug jumps use it to land under or over
  thick cloud).
- **Density:** the cube's cover (where the weather is, hundreds of km), shaped like weather rather
  than a sponge (cutting holes all over it with one noise read as round craters of one size):
  - the wind blows round the world's axis: shapes are stretched ~2× along it (streets, bands), and
    a slow swirl warps them so edges are ragged. See **Stretched along the wind** below;
  - the heart of a system (thick cover) stays a sheet, with swells tens of km across in how thick
    it is (stratus);
  - its edges (thinner cover) break into clumps a few km across with gaps between (cumulus).

  Then a height profile (thicker cover rises higher; ~8 km cells rise and fall; soft base, rounded
  tops), eroded by three octaves of 3D noise (softer inside thick cover, or its tops were pocked
  with shadowed pits), drifting with the wind.
- **Light:** at each sample (from where its light comes from: a step's first ~250 m, not its middle; from orbit the steps are over a km long, and lit from deep inside them the tops of thick cloud were grey), the sun through the cloud above it (5 steps toward it, doubling from
  120 m), with multiple scattering approximated as octaves each less attenuated, weaker and less
  forward (Frostbite's): clouds are bright from every side, with a silver lining toward the sun. Half of each octave's light goes to a weaker backward lobe (`BACK`): thick cloud is bright seen from the sun's side, as from orbit by day (at a quarter, the tops were greyer than the snow under them). Plus
  a little skylight, the sunlight's colour through the air, and eclipses and ring shadows
  (`shadow.wgsl sunShade`).
- **Air:** the haze between the camera and the first cloud, as for the ground. All the air's
  inscatter (`atmo.wgsl atRolloff`) is compressed and paled over a knee: a grazing path low in the
  air saturates every colour at 3–5× white, and the horizon was a wide flat-white band. It levels
  off at ~0.95 (knee 0.5, `ATR_K` 2.2), paled toward white as before (paled less, the distant clouds by the horizon went yellow). What's seen through the haze dims through a long path's reddened light, paled by the same amount the haze is; otherwise distant clouds by the horizon went yellow under a white haze (SPACE-73). At 1.37 the tone map, white from 0.8
  up, still made the near-horizon sky flat white, worst filling the periscope's view.
- **Ground under the clouds:** where the volumetric clouds are on, the ground's own cloud-deck
  shadow (`planet.wgsl`) gives way to their overcast dimming (`skyDim`). Together they left ~5 % of
  daylight, the ground near black under cover.
  The dimming of a surface (ground, sea) is its own cloud shadow: where the sun's ray from it crosses the clouds. By the air's shade along the line of sight, shadow columns crossing it painted the ground and the sea in dark streaks running to the point opposite the sun. The sky keeps the air's. A lone cloud's shadow keeps the blue sky's light, ~45 % left under it, down to a fifth as the sky clouds over (by the air's shade along the line of sight); at a fifth throughout, scattered clouds' shadows were near black. It fades out 20–60 km away, where what you see is mostly the air's haze over the surface: it dimmed the haze too, in dark dashes along the horizon.
- **Under overcast** (`vclouds.wgsl`, after the march): below the cloud base, with thick cover overhead (from 0.5, full by 0.8), the air is a grey, even fog lit by the light through the clouds (a fifth of the sun's at the base, by day; twilight's at dusk; the night's faint glow), thickening with distance (an e-fold every ~12 km), over everything in front of the scene or the cloud base: up to 85 % near, 97 % 30–120 km off (at 85 % throughout, the sunlit land and sky beyond the overcast showed as a bright line along the horizon). Before, the air's haze stayed the clear day's blue, and the far land sharp under a grey ceiling.
  - **Cloud undersides** get 0.2 of the sun's light diffused through (at the base; more higher up): at 0.05 an overcast's base was near black from under it, where it's a mid grey.
  - **The eye adapts** to an overcast too (`render/exposure.ts overcastBoost`): up to 1.8× under full cover, under the clouds and in them (stopping at the base, the inside of a thick cloud was a dark murk).
  - The fog fades out over the layer's lowest 2 km as you rise into it (cut off at the base, the view changed at once there).
- **Inside the layer, past the march's reach** (100 km), the layer goes on: by the cover over you, a haze of the light the clouds marched so far showed (an e-fold every ~50 km under full cover). Cut off there, the view cleared abruptly in a band along the horizon. Only well inside the layer (fading out near its top and base, where rays skimming along it cross thin, shadowed edges, and taken as the layer's colour they drew a dark band along the horizon), and no darker than the clouds' plain light.
- **The temporal blend** drops last frame's where the brightness jumped (relatively, over 0.35–0.7): lightning came or went. Blended, a flash showed at once only where the view had turned past last frame's, a ghost the screen's shape.
- **Storms** (`clouds.wgsl stormAt`, `flashAt`): in the thickest weather (cover from 0.7), areas a few hundred km across (a 200 km noise, about a fifth of it).
  - **Thunderclouds:** the towers there reach the layer's top, and an anvil spreads over the storm near it (from 0.64–0.88 of the layer to its top: 12–14 km on an Earth), over the towers. Its underside rises and falls ~±1 km over tens of km and its thickness is patchy, so the erosion breaks it up: a flat, even sheet was featureless fog from inside it, its underside a straight line across the view.
  - **Lightning:** storms are cut into 60 km cells (a 3D grid through the world), each with a flash point near its middle at mid-cloud height. Every 0.8 s a cell in a storm flashes with a 1 in 7 chance, flickering for a quarter of that, lighting the cloud round its point (a 10 km Gaussian, gone by the cell's edge, so only a point's own cell is looked up). Bluish white, up to 8× the sun's light; a quarter of that by day. In the volumetric clouds and the flat deck alike, so from orbit the night side's storms flicker. Its clock is the time wrapped to an hour (`world.waveO.w`); its hash is an integer one (sin of large arguments, the usual shader hash, came out nearly constant on the GPU, and nothing flashed). From orbit at 3–7 km the glows were too small and faint to see.
  - **Strikes near you** (`sim/lightning.ts`; kept relative to their world, which moves on along its orbit at tens of km/s: in system coordinates the bolt slid across the view as it flashed): the clouds' flashes are worked out per pixel on the GPU, where nothing else sees them, so the game makes its own strikes: under storm cover (over 90 % of the most the world has, overhead), below the clouds' top, one every 3–12 s somewhere 1.5–20 km off where the cover is that thick too. Each lasts 0.6 s: four return strokes, each a sharp peak decaying in ~40 ms (`strikeGlow`). It
    - **is drawn** (`tonemap.wgsl`, `gpu/post.ts boltOf`): a jagged channel from the cloud base to the ground in 22 steps with two or three branches off its upper half (`boltPath`), projected on the CPU; a white-hot core a pixel or two across in a bluish glow, hidden where the scene is nearer;
    - **lights** the ground and the clouds (`frame.wgsl strikeLight`, from the bolt's lower third, with the square of the distance: ~1 at 2 km) and the cloud round where it leaves the base (a 2.5 km glow);
    - **flashes the whole view** (full within ~8 km, with the distance's square beyond);
    - **is heard** (`audio/ShipAudio.ts thunder`): after the sound's delay (343 m/s), a sharp crack under ~3 km, then a rumble of low noise, longer, deeper and softer the farther it is, swelling a few times.
- **Cities under the clouds at night** (`clouds.wgsl cityGlowAt`): their light scattered up through the cloud, warm, by how populated the ground below is (`city.wgsl cityPop`, from the cube's coarse ground height), where both suns are down. On the flat deck by its cover; in the volumetric clouds taken once per ray (at its middle), stronger low in the cloud. From orbit, clouds over a populated region glow a dim amber.
- **Rainbows** (`gpu/post.ts bowOf`, `tonemap.wgsl rainbow`): under the clouds on a rainy world, by day with the sun under 42°, where it's raining a few km off away from the sun (the cover there near its most, as the rain) and the sun reaches you (the cover where its ray crosses the cloud base well under that). The primary bow 40.6–42.4° from the point opposite the sun (violet inside, red out), the secondary 50.3–53.5° reversed at a quarter, Alexander's dark band between, the sky a little brighter inside; colours paled a little (the sun's a disc). Only in the rain between you and the scene: fading out before anything nearer than ~4 km (painted over the near ground, it read as a sticker).
- **Cirrus:** a thin sheet of ice crystals 1.35 deck heights up (~11 km on Venydes 5), not
  marched: one lookup where the ray crosses it (`vclouds.wgsl cirrus`), drawn at full resolution
  in the pass that lays the clouds over the frame (`fsComposite`). At the march's half resolution,
  blurred, it was soft.
  - Stretched along the wind as the lower clouds are (below). Round, it was fuzzy blobs fading
    out at their edges from orbit.
  - **Plumes** a few hundred km long, ~3× along the wind and swirled, their edges frayed by the
    streaks in them.
  - **Filaments:** ridged noise (thin lines) ~7× along the wind, every ~16 and 4 km, and finer
    streaky texture at 1.4 and 0.5 km; each fades to its mean once under a couple of pixels. The
    16 km ones hold from orbit. At 25× they were scratches; swirled as much as the plumes, they
    meandered like rivers; the fine ones as ridged lines were scratches too, or less stretched, a
    web of veins.
  - **A soft veil** round the filaments (alone, the lines read as scratches on the view).
  - Opacity up to ~0.5 (more seen edge-on), thinning to 15 % of that once the sun's gone from it: unlit, over the twilit clouds and ground under it, it drew dark stripes across them. It's lit white, brighter toward the sun, with the air in front hazing it. It lies in
  front of the lower clouds from above and behind them from below.
- **Stretched along the wind** (`clouds.wgsl windStretch`, SPACE-74): the wind blows along the
  latitude circles, so a point's longitude in the weather's frame is scaled by s (each latitude
  circle turned by its own angle), and 3D noise read there is 1/s longer along the wind, with no
  shear. Squashing a point's own coordinates along its east, as before, did nothing (east is
  square to where the point is): the lower clouds had no streets, the cirrus was round. The scaled
  longitude jumps where it wraps; that seam is on the meridian opposite the camera (`windSeam`),
  and a second layout seamed under the camera takes over within ~45° of it (`windBlend`). Each
  layout only changes where its weight is 0 as you move, so nothing visibly jumps; near a pole,
  where the far meridian can be in view, the two blend there.
- **Changing shape:** the cloud map is read twice (`clouds.wgsl cloudMap`), once with the wind and
  once slower, round a tilted axis and from another part of the map. The two slide past each other,
  so weather systems grow, merge and die away over hours. Swells evolve over ~an hour, clumps and
  towers over ~15 min, the finest detail over a few minutes.
- **Shadows of what's near:** the sunlight at each sample goes through the shadow map too
  (`frame.wgsl shadowAtPoint`, one tap), so a sky station, or a ship, shadows the clouds under it.
  It works within the cascades' 30 km, while the map is on (a station within 30 km).
- **Upsampling:** the half-res result is laid over the frame (`vclouds.wgsl fsComposite`, the same
  module as the march) through a 3 × 3 filter weighted by
  how alike the scene's depth is where each texel was marched and at the pixel. Blurred across an
  edge, sky clouds bled onto the far terrain and back, a soft low-res band along the horizon.
- **Over high ground:** the layer is lifted so its base clears the ground (`liftAt`).
  - Everywhere, by the ground's coarse height: 8 octaves, ranges rather than ridges, baked with the cover into the cloud cube's second channel (`cloudBake.wgsl`, `clouds.wgsl cloudLiftAt`). The base clears it by 1.2 km plus a fifth of the relief, for the finer peaks.
  - Near you, by the exact ground under you (`vp.lift`), fading out 30–80 km away.
  - The flat deck is lifted the same way, and writes the lifted point's depth.
  - Why: an Earth-like world's ground reaches ~1.3 × its relief (11 km on Venydes 5), and a fifth of it lies above the cloud base (3.3 km). From orbit the highlands' terrain cut holes in both layers, with the haze's gradient round them. With 11 octaves the cloud tops were corrugated along the ridges.
  - The march reaches the top at its most lifted (`liftTop`). Whether you're in the layer or above it goes by the lift under you (`liftCam`).
- **Inside the layer:** 64 steps over at most 100 km (48 over 250 km banded the clouds across a
  gap). The blend with last frame's result trusts this frame more (0.2 → 0.6) where the two differ
  a lot in what shows through: a cloud edge moved across, and the old one trailed as a ghost.
- **Wind:** the weather turns round the world's axis 2.5 × 10⁻⁶ rad/s faster than the ground (~16 m/s
  at an Earth's equator; `clouds.wgsl cloudDir`, `sim/clouds.ts CLOUD_WIND`). The deck, the
  volumetric clouds and their shadows on the ground all read the cloud map through it, so they move
  together. The finest detail also boils, changing over a few minutes. Before, they drifted at
  ~4 cm/s, still to the eye.
- **Level of detail:** steps no finer than 0.4 % of the distance to the layer (150 m at least),
  12–48 a ray, and 3 sun steps, not 5, from over 50 km. From 300 km a screen full of clouds cost
  6.5 ms and pushed the dynamic resolution down to half; now it's ~1.9 ms at 1200 × 750.
- **Steps:** up to 48, spaced quadratically along the ray's stretch in the layer (fine near, coarse far):
  evenly, from inside the layer rays skimming 250 km and rays ending at the nearby cloud base were
  sampled 12× apart, and the fog differed across the base's horizon as a hard line.
- **Noise:** each ray starts at a jittered offset (interleaved gradient noise, moving each frame),
  and the result is blended 80/20 with last frame's, reprojected by the clouds' distance, so the
  grain averages out over a few frames. It's reprojected by where the visible cloud mostly is (distance weighted by each step's share; by the
  first cloud sample, inside fog metres off, moving fetched the wrong history and the jitter showed as
  static), and the composite takes four bilinear taps round each pixel. The reprojection follows the world's turn and orbit (the
  clouds move with it): taken as still in space, they were off by the orbit's 30 km/s and smeared
  upward whenever the game ran.
- **Light shafts, and the shade under the deck:** below the deck, 12 samples along the first 30 km
  of the ray test whether the clouds hide the sun from there (3 density samples up through the
  layer). That share, weighted by the air's density, is taken for the whole stretch of air under
  the deck (to the ground, or to the cloud base: ~200 km toward the horizon).
  - What's behind, sky or ground, is dimmed by 80 % of that share as a whole (the composite's
    transmittance). The ground is dimmed evenly: its ambient light and the sea's sky reflection
    aren't shaded in its own shader, and dimmed only past a few km the ground near you stood in a
    lighter circle. A fifth is left, so an overcast day doesn't look like night.
  - So is the haze in front of the clouds.
  - The lit stretches glow with sunlight scattered forward by the haze's particles (Mie,
    `MIE_B`: white to golden, strongest toward the sun). Otherwise the shafts were just the blue
    sky showing between the shaded stretches. It only appears where clouds shade some of the air
    (from 10 % of it), so a clear sky is left as the sky shader draws it (without Mie haze).
  - This gives shafts under broken cloud and a dim world under overcast.
  - Dimming only the first 30 km, or taking that stretch's compressed haze off (`atmo.wgsl
    atRolloff`), left a yellow line along the horizon under overcast.
- **Cost** (M-series, 2400 × 1500): about 2 ms looking down from above the deck, 3 ms from 50 km,
  1–2 ms from below.

## Next

- Cloud shadows on the ground from the volumes rather than the flat deck.
