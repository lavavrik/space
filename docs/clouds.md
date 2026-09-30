# Clouds

Earth-like and ocean worlds have a cloud deck. Its pattern is one per world, baked once into a
cube map in the world's own frame (`cloudBake.wgsl`, from `clouds.wgsl cloudRaw`), and used three
ways:

- **From afar: a flat deck** (`cloudLayer.wgsl`): a shell at the deck's height (1.3 scale heights),
  its cover from the cube plus finer noise octaves, lit and hazed like the ground.
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
    a slow swirl warps them so edges are ragged;
  - the heart of a system (thick cover) stays a sheet, with swells tens of km across in how thick
    it is (stratus);
  - its edges (thinner cover) break into clumps a few km across with gaps between (cumulus).

  Then a height profile (thicker cover rises higher; ~8 km cells rise and fall; soft base, rounded
  tops), eroded by three octaves of 3D noise (softer inside thick cover, or its tops were pocked
  with shadowed pits), drifting with the wind.
- **Light:** at each sample, the sun through the cloud above it (5 steps toward it, doubling from
  120 m), with multiple scattering approximated as octaves each less attenuated, weaker and less
  forward (Frostbite's): clouds are bright from every side, with a silver lining toward the sun. Plus
  a little skylight, the sunlight's colour through the air, and eclipses and ring shadows
  (`shadow.wgsl sunShade`).
- **Air:** the haze between the camera and the first cloud, as for the ground. All the air's
  inscatter (`atmo.wgsl atRolloff`) is compressed and paled over a knee: a grazing path low in the
  air saturates every colour at 3–5× white, and the horizon was a wide flat-white band.
- **Steps:** 48, spaced quadratically along the ray's stretch in the layer (fine near, coarse far):
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
