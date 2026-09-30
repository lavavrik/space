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
over the frame: scene × what the clouds let through + their light.

- **Cover:** Earth-like and ocean worlds are clouded over most of their face (`clouds.wgsl
  cloudCover`: from a raw −0.2, not 0.02 as the others), with clear stretches between systems;
  `sim/clouds.ts` is the same function on the CPU (the debug jumps use it to land under or over
  thick cloud).
- **Density:** the cube's cover, broken into ~20 km fields and ~4 km clumps (the cube alone gave
  whole regions of full cover that read as one fog sheet), shaped by a height profile (thicker cover rises higher; ~8 km cells
  rise and fall so the tops aren't one carpet; soft base, rounded tops) and eroded by three octaves of
  3D noise (billows a couple of km across, finer wisps), drifting with the wind.
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
- **Light shafts:** below the deck, 12 samples along the first 30 km of the ray through the air test whether the clouds
  hide the sun from there (3 density samples up through the layer); the haze along the ray is dimmed
  by half that share, weighted by the air's density, and written as negative light, so the composite
  takes it off the sky and the ground: shafts under broken cloud, a dim world under overcast.
- **Cost** (M-series, 2400 × 1500): about 2 ms looking down from above the deck, 3 ms from 50 km,
  1–2 ms from below.

## Next

- Cloud shadows on the ground from the volumes rather than the flat deck.
