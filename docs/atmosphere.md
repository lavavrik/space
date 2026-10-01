# Atmospheres and clouds

Desert, Earth-like, ocean, some volcanic worlds, a few big cold icy ones and the giants have air. It drags on the ship, heats it on the way in, colours the sky, hazes the distance, reddens the sun toward sunset, and carries clouds: water on Earth-like and ocean worlds, dust storms on deserts, an acid deck on Venus-like worlds, methane on Titans, and the giants' own (docs/clouds.md "Kinds").

## The air (`sim/atmosphere.ts`)

Every world with air gets its own, generated from its seed (`makeAir`): a surface pressure and a mix of gases. The rest follows from those and the world:

| Type | Surface pressure | Gases |
|---|---|---|
| Desert | mostly 4–80 mbar (Mars-like); some 0.1–1.5 bar; ~1 in 8 hot ones 8–60 bar (runaway greenhouse) | CO₂, N₂, Ar; SO₂ in the thick ones |
| Earth-like | 0.6–2.2 bar | N₂ 70–82 %, O₂ 15–26 %, Ar, H₂O, CO₂ |
| Ocean | 1–4 bar | N₂, O₂ 6–20 %, more water vapour |
| Volcanic, hot (≥ 300 K) | 20–95 bar (Venus) | CO₂ ~96 %, N₂, SO₂ |
| Volcanic, cold | 1–50 mbar (tidally heated moons: an Io-like haze, thicker) | SO₂ ~90 % |
| Icy, a few (Titan) | 0.8–3 bar: only big (≥ 1,500 km) cold (< 150 K) ones, one in three (`universe/worlds.ts titanLike`; the rest have none, as Triton's and Pluto's are a hundred-thousandth as thick) | N₂ ~95 %, CH₄ 1.5–6 % |
| Gas giant | 1 bar at the cloud tops | H₂ 84–90 %, He, CH₄, NH₃ |
| Ice giant | 1 bar at the cloud tops | H₂ ~80 %, He 14–19 %, CH₄ 1.5–2.5 % |

- **Molar mass:** the mix's average (`GASES`).
- **Greenhouse:** the surface is warmer than the world's equilibrium temperature: Ts = T · (1 + 0.75 τ)^¼, with an infrared optical depth τ = P(bar) · (0.5 + Σ x·k), k per gas (CO₂ 2.2, H₂O 25, SO₂ 8, CH₄ 20, NH₃ 10 per bar). Earth-like worlds come out 20–40 K warmer; a thick CO₂ world hundreds of K (a 21-bar desert at 540 K equilibrium: 1,380 K). Giants: none at the cloud tops.
- **Density:** ρ0 = P · M / (R · Ts), an ideal gas: Earth 1.2 kg/m³, a Mars-like desert ~0.01–0.06, a Venus-like world 50–100.
- **Scale height:** H = R · Ts / (M · g) (Earth-like ~6–10 km; a light, hot, low-gravity desert 25 km). Density and pressure fall as e^(−h/H); the air ends at 12 scale heights (`ATMO_TOP_H`).
- **Air temperature:** Ts at the ground, cooling with height toward the world's skin temperature (0.84 T) over ~1.5 H (`airTemp`).
- **Moving air:** the air turns with its world, so speed through it is measured against that motion.
- **Lowest safe orbit:** above the air (`orbits.ts minOrbitAlt`), since drag would bring a lower orbit down. Station orbits follow.
- **In the info panel (I)**, once scanned: CLIMATE (surface temperature and the greenhouse warming), ATMOSPHERE (pressure, density against Earth's), COMPOSITION (the three main gases), AIR COLUMN (scale height and where it ends), and on hot worlds ON THE GROUND: where the hull heads, or how soon it fails. The influences panel (B) shows the air around the ship (pressure, density, temperature). The flight panel shows it too, under ALT, whenever you're in a world's air: `AIR` pressure · temperature, and your airspeed while flying (the air turns with its world, so holding still over a giant is a km/s wind), amber while it's heating the hull (`hud/snapshot.ts`).

Venydes 2 (a hot desert, 566 K, 0.45 g) used to get a fixed desert air of 0.25 kg/m³ with a 24 km scale height at 566 K, which is why it looked thick and heated the hull on the way down. Now it's a thin 13 mbar of CO₂: still hot and tall, but ~20× thinner.

## Pressure

The hull is rated to 100 bar (`HULL_P_MAX`). Past it, it's crushed (`sim/flight.ts collide`, at
`crushDepth` under the mean radius: ln(100 bar / P0) scale heights). That's 4.6 scale heights into a
giant (~75 km), and on the thickest Venus-like worlds (95 bar) the deepest valleys. The flight
panel's AIR line shows how near it you are from half of it, amber from 80 %.

## Heat from the air

- **Convection:** the hull trades heat with the air, ~15 W/m²K in still sea-level air, more in denser or faster air (`thermal.ts`). It works on the ground too (and under time warp there).
- **Sky glow:** in air the sky isn't cold space. The air above glows at its own temperature as far as it's opaque in the infrared, 1 − e^−τ(above): about half the sky on an Earth-like world, all of it under a thick CO₂ blanket (`SKY GLOW` in the heat breakdown). The radiators' fins get it too, so they can't dump heat into hot air.
- **What that means on the ground:** on an Earth-like world, nothing much. On a hot thin desert the hull drifts slowly toward the air's temperature. Under a thick hot atmosphere it can't shed heat at all. At ~740 K (Venus-like) the hull settles above the 600 K drive limit, so no FTL until you've climbed out on thrusters. At 1,300 K it fails within a couple of minutes.

## Drag and entry heating

- **Drag:** a = ρ v² · Cd · A / (2m), with Cd = 1 and A the ship's cross-section along its motion through the air. Nose-first is ~6× smaller than side-on (`thermal.ts crossSection`). Near an Earth-like world's surface this gives a terminal speed around 85 m/s.
- **Entry heating:** Sutton–Graves stagnation heating, q = 1.74e-4 · √(ρ/rₙ) · v³ W/m², over the same cross-section. The ship has no heat shield, so all of it soaks into the hull. The effective nose radius (0.6 m: edges and fittings, not the 12 m hull) is tuned for play. From 70 km:

| Entry | Hull peak |
|---|---|
| gentle 3 km/s | ~400 K |
| shallow 5 km/s | ~580 K |
| steep 6.5 km/s | ~720 K |

  Faster or steeper entries can cook the hull (900 K fails).
- **Where it shows:**
  - the heat breakdown (B) has ENTRY HEATING and AIR rows;
  - the dashboard gets an entry-heating lamp;
  - an orange glow creeps in from the screen's edges (`#plasma`, 10 MW → 1 GW);
  - the approach strip's ATMOSPHERE mark is the top of the air.

## Sky, haze and sunlight (`render/shaders/atmo.glsl`)

- **Model:** single scattering with the exponential density. Sunlight reaching each point along a ray is dimmed by the optical depth toward the sun (Schüler's approximation of the Chapman function; zero behind the planet). It's scattered toward the camera with a Rayleigh phase (plus a glow round the sun) and dimmed on the way out.
  - **Each step's light** is its exact integral, (1 − e^(−ext·ρ·ds)) / ext, behind the air before it (in thin air that's just ρ·ds). Taken as ρ·ds dimmed by the step's own whole depth, a step thick enough to hide what's past it counted almost nothing: in a Titan's or a Venus's air, edge-on along the limb where the steps are long, the sky was a dark speckled band (or a thin blue line) round the world (SPACE-80).
- **Colour:** Earth-like and ocean worlds scatter like air (∝ λ⁻⁴: blue sky, red sunsets). Other worlds scatter in their palette's sky colour, thicker the denser the air (`airBeta`).
- **A Titan's smog** (the icy worlds with air): 3× as thick, scattering near grey, and absorbing too, the blue most (`atmo.wgsl atExt`, `world.smog`), so what it scatters and what gets through it is orange. Scattering alone, however thick, its light came out white to lavender from orbit (the red scattered out of the sunlight on its way in) and olive from the ground. At 6× it hid the ground from orbit, but under it the day was near black: single scattering misses the light that really gets down.
- **Sky:** a shell at the top of the air (`atmosphere.frag.glsl`, 8 samples). From inside it's the sky: blue overhead, pale at the horizon, orange at sunset, darkening with height. From orbit it's the glowing limb. It dims what's behind it by its brightness, so stars disappear by day.
- **Sunset and twilight** (`gpu/shaders/atmo.wgsl`):
  - **Ozone** (`atExt`): absorption in green and orange, by the air's oxygen (Earth's: Chappuis band, (0.65, 1.88, 0.085) × 1e-6 /m beside Rayleigh's blue 33.1e-6; `world.ozone`, 1 for 21 % O₂). It hardly shows by day; along twilight's long paths it keeps the sky blue overhead and the far side pink over the world's shadow. Without it, reddened sunlight and the scattered blue went green.
  - **Haze** (Mie): grey, strongly forward (Henyey-Greenstein, g 0.76), 7 % of the air's blue: the sun's aureole, orange when it's low. (Before: a weak tinted cos¹² lobe, and no glow round a setting sun.)
  - **Low haze** (aerosols: dust, droplets; `atmo.wgsl atBL`): most of the air's aerosols lie low, so a second layer with 0.15 of the air's scale height (Earth's ~1.2 km), scattering 3× the air's blue at the ground, no more than 6e-5 /m (an aerosol depth of ~0.07, a fairly clear day; aerosols are dust and moisture, not air, so a dense air doesn't make it a fog). Grey, it dims what's behind it as well as lighting the path, and its phase is broader (0.6 of the forward lobe, 0.4 of a gentle g 0.2 one, standing in for its light scattered again and again), so it's pale away from the sun too. From a low flight, far land fades to a pale, greyish haze, and the horizon seen from the ground is a whitish band under the blue. (Without it, the long near-level paths saw only the air's own blue added over undimmed ground: green land went a saturated turquoise by ~30 km and read as sea. From orbit it hardly shows: the column is thin.) ~0.06 ms at 4K over the clouds; `?tdbg=524288` (or `farlightTdbg.bits` in a dev build's console) turns it off for A/B shots.
  - **Paled less at sunset:** the bright-haze rolloff pales toward white (the horizon by day); where the sunlight at the path's start is deeply reddened (the sun right at the horizon) it pales up to half as much, or the sunset sky was washed-out yellow-white. (Up to 85 % less, from a mildly reddened sun, a sunrise seen from up high was orange end to end.)
  - **Twilight's glow** (`atTwilight`): once the sun is down, the sky's light is mostly multiply scattered, which single scattering leaves out (the sky went black at −2°). A glow peaking with the sun just below the horizon, gone by ~12° below and ~8° above, bluish, warmer toward the sun; added to the sky by the air along the ray, and as light on the clouds and cirrus.
  - **The eye adapts** (`render/exposure.ts twilightBoost`, with auto-exposure off): up to 4× exposure while the higher sun is between ~4° above and ~8° below the horizon, back to 1 by ~12° below, in the air only (gone by 5 scale heights up). Also `frame.twilight`, for the sky and the flat cloud deck, which aren't × exposure.
  - **Clouds** at sunset are lit by the sun as long as it reaches them (reddened by the air): an extra dimming by the sun's height made them dull grey (`vclouds.wgsl` sunUp; the sky's light on them keeps it).
  - The tone map keeps hue up to ~3× white (docs/post.md), or a sunset's orange went yellow.
- **Airglow** (`atmosphere.wgsl`, on worlds with oxygen): a thin shell of faint green light high in the air (85 % of the way to its top: ~95 km on Earth, 4 % of the air's depth thick), at night. Seen edge-on, a ray's path through it is ~80× its thickness (`shellPath`), so the limb of the night side carries a faint green line, as from orbit.
- **Auroras** (`atmo.wgsl aurora`): on oxygen-rich worlds green low and red higher up; on gas and ice giants pink and violet (hydrogen). An oval round each pole (~70° of latitude, wandering ±1.5° along it, a couple of degrees wide) in the upper half of the air (55–98 % of the way to its top), where it's night there: curtains of fine vertical rays (noise along the longitude, drifting) that fold and brighten slowly. Integrated along the ray through that shell in 12 steps (none read far from the oval), so seen edge-on (from orbit, at the limb) a curtain's light adds up, and from under it it's a band of rays fanning up from the horizon. The sky shell adds it, and the planet's own shader too: over the disc the shell's far side is behind the surface, and from orbit it only showed at the limb. On giants 5× (their far deeper air diluted it to nothing).
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
