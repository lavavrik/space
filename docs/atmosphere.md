# Atmospheres and clouds

Desert, Earth-like, ocean, some volcanic worlds and the giants have air. It drags on the ship, heats it on the way in, colours the sky, hazes the distance, reddens the sun toward sunset, and carries a cloud layer on Earth-like and ocean worlds.

## The air (`sim/atmosphere.ts`)

- **Density:** ρ(h) = ρ0 · e^(−h/H) above the mean radius. The atmosphere ends at 12 scale heights (`ATMO_TOP_H`), where density is 6 millionths of the surface's.
- **Scale height:** H = R·T / (M·g), from the world's equilibrium temperature and surface gravity. An Earth-like world comes out at ~7 km.
- **By type** (ρ0 and molar mass M):

| Type | ρ0 (kg/m³) | Gas |
|---|---|---|
| Desert | 0.25 | thin CO₂ |
| Earth-like | 1.2 | N₂/O₂ |
| Ocean | 1.5 | N₂/O₂ |
| Volcanic (when it has air) | 8 | thick CO₂ |
| Giants | 0.5 at the cloud tops | H₂/He |

- **Moving air:** the air turns with its world, so speed through it is measured against that motion.
- **Lowest safe orbit:** now above the air (`orbits.ts minOrbitAlt`), since drag would bring a lower orbit down. Station orbits follow.

## Drag and entry heating

- **Drag:** a = ρ v² · Cd · A / (2m), with Cd = 1 and A the ship's cross-section along its motion through the air. Nose-first is ~6× smaller than side-on (`thermal.ts crossSection`). Near an Earth-like world's surface this gives a terminal speed around 85 m/s.
- **Entry heating:** Sutton–Graves stagnation heating, q = 1.74e-4 · √(ρ/rₙ) · v³ W/m², over the same cross-section. The ship has no heat shield, so all of it soaks into the hull. The effective nose radius (0.6 m: edges and fittings, not the 12 m hull) is tuned for play. From 70 km:

| Entry | Hull peak |
|---|---|
| gentle 3 km/s | ~400 K |
| shallow 5 km/s | ~580 K |
| steep 6.5 km/s | ~720 K |

  Faster or steeper entries can cook the hull (900 K fails).
- **Convection:** in air the hull also trades heat with the air (~15 W/m²K in still sea-level air, more at speed), so it settles toward the air's temperature.
- **Where it shows:**
  - the heat breakdown (B) has ENTRY HEATING and AIR rows;
  - the dashboard gets an entry-heating lamp;
  - an orange glow creeps in from the screen's edges (`#plasma`, 10 MW → 1 GW);
  - the approach strip's ATMOSPHERE mark is the top of the air.

## Sky, haze and sunlight (`render/shaders/atmo.glsl`)

- **Model:** single scattering with the exponential density. Sunlight reaching each point along a ray is dimmed by the optical depth toward the sun (Schüler's approximation of the Chapman function; zero behind the planet). It's scattered toward the camera with a Rayleigh phase (plus a glow round the sun) and dimmed on the way out.
- **Colour:** Earth-like and ocean worlds scatter like air (∝ λ⁻⁴: blue sky, red sunsets). Other worlds scatter in their palette's sky colour, thicker the denser the air (`airBeta`).
- **Sky:** a shell at the top of the air (`atmosphere.frag.glsl`, 8 samples). From inside it's the sky: blue overhead, pale at the horizon, orange at sunset, darkening with height. From orbit it's the glowing limb. It dims what's behind it by its brightness, so stars disappear by day.
- **Ground:** the planet shader applies the same model to the air between the camera and the ground (haze; per vertex on terrain chunks, per pixel on the far sphere). It also reddens and dims sunlight through the air, and adds a little skylight in shadows by day.

## Clouds (`cloudLayer.frag.glsl`, `clouds.glsl`)

- **A real layer:** clouds sit at the deck's height (1.3 scale heights, ~9 km on an Earth-like world) instead of being painted on the ground. You can fly above, through or below them, and they show parallax against the terrain.
- **Drawing:** the layer is a shell. Each pixel intersects its ray with the exact sphere, so there are no facets.
- **Lighting:** cloud tops are lit by the (reddened) sun; seen from below, thick parts are darker. The air in between hazes them.
- **Pattern:** the large-scale pattern (the same noise that used to paint the surface) is baked once per world into a 1024² cube map in the world's own frame. The layer adds up to 4 finer octaves as you get closer.
- **Cloud shadows:** the ground reads the same map where the sun's ray from it crosses the deck, so shadows sit under their clouds.
- **No drift:** the pattern turns with the world. The old drift moved clouds ~11 km/s, far too fast seen from near the ground.

## Performance

A ground view on the preview window cost ~13 ms of GPU with all of it on, against ~11 ms with the air switched off. Two things keep it there: the baked cloud map (one texture read for shadows) and per-vertex haze on terrain. From orbit it's about the same as before.
