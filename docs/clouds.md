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

- **Density:** the cube's cover, shaped by a height profile (thicker cover rises higher; ~8 km cells
  rise and fall so the tops aren't one carpet; soft base, rounded tops) and eroded by three octaves of
  3D noise (billows a couple of km across, finer wisps), drifting with the wind.
- **Light:** at each sample, the sun through the cloud above it (5 steps toward it, doubling from
  120 m), with multiple scattering approximated as octaves each less attenuated, weaker and less
  forward (Frostbite's): clouds are bright from every side, with a silver lining toward the sun. Plus
  a little skylight, the sunlight's colour through the air, and eclipses and ring shadows
  (`shadow.wgsl sunShade`).
- **Air:** the haze between the camera and the first cloud, as for the ground.
- **Noise:** each ray starts at a jittered offset (interleaved gradient noise, moving each frame),
  and the result is blended 80/20 with last frame's, reprojected by the clouds' distance, so the
  grain averages out over a few frames.
- **Cost** (M-series, 2400 × 1500): about 2 ms looking down from above the deck, 3 ms from 50 km.

## Next

- Light shafts: the air's inscatter shadowed by the clouds (march the air too, reading the cloud
  density toward the sun).
- Cloud shadows on the ground from the volumes rather than the flat deck.
