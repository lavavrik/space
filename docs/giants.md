# Gas and ice giants

Their face is their cloud tops, drawn in the planet shader (`planet.wgsl giantSurface`, in
`giant.wgsl`, shared with the clouds). From orbit what matters is motion and structure; up close you
can fly down into them (Clouds, below).

- **Jets:** each latitude turns at its own rate, alternating east and west (`giantJets`), up to
  1.2 × 10⁻⁵ rad/s (~1 km/s on a Jupiter-sized world; ice giants 60 % of that). The pattern is
  carried along by it.
- **Flow noise:** sheared for ever, the pattern would smear into streaks. So it's read twice, each
  carried along for up to `GIANT_FLOW_T` (40 min), half a period apart, and cross-faded. It keeps
  flowing and never smears.
- **Bands:** two sets of bands with wavy edges, wavier where neighbouring jets shear hardest.
  - Fine streaks run along them.
  - Eddies sit in the shear zones, stirring in the third colour.
  - Ice giants are subtler: lower contrast, fewer bands, less turbulence.
- **Storms:** 6 on a gas giant, 2 on an ice giant. Each is an oval twice as long as it's high,
  riding its latitude's jet. One is big (Great Red Spot-sized), the rest small.
  - Each swirls the pattern round its centre, turning slowly: anticyclonic in the south, cyclonic
    in the north.
  - Each is drawn as a dark or coloured core (palette D) with a pale collar.
- **Haze:** a giant's air is 0.3× as thick in the sky shader (`render/look.ts airBeta`). At full
  strength the haze above the cloud tops washed an ice giant out to white, and hid its bands and
  storms.

## Clouds

Under ~150 km the face becomes volumetric clouds (`vclouds.wgsl`, cloud kind `giant`,
sim/cloudKind.ts), the same march as a water world's, fading in as the painted face's detail would
run out.

- **Where:** from 0.26 scale heights over the face down to 4.3 under it, just over where the hull
  gives (the deck is 0.25 H: its base is −17.2 deck heights, `cloudBaseK`). Cover 0.85–1 everywhere.
  Its shapes are laid out in scale heights from the face (`vclouds.wgsl density`, z), not shares of
  the layer, so they stay put if its depth changes.
- **Colour:** the bands' at the place each pixel's ray meets the clouds (`giant.wgsl giantColAt`:
  coarse, no turbulence, one call a pixel), so from above they carry on the painted face.
- **Tops:** at the face, rolling from 0.13 scale heights under it to 0.26 over it in ~8 km cells,
  crisp (over 0.17: fading over the layer's upper half they were a featureless glow from above),
  eroded into billows.
- **Two decks** (ammonia over ammonium hydrosulphide, as a Jupiter's), clear air between, 0.57–0.84
  scale heights under the face (~9–14 km), its floor and ceiling rolling. One 45 km sheet was fog all the way down. The
  lower deck gets a tenth of the light, diffused through the upper (the short march toward the sun
  doesn't reach through it: lit as if it weren't there, it was a bright flat floor).
- **No light shafts** in a giant (`vclouds.wgsl rays`): they're for clear air under a deck, and their shade toward the sun, taken over a few km, missed the deck above: deep in it, looking up toward the sun was a blinding white patch.
- **No flat deck** over the face (`gpu/worlds.ts`): it is the cloud tops.
- **Crush depth:** where the air reaches the hull's limit, 100 bar (`HULL_P_MAX`): ln 100 = 4.6
  scale heights under the 1-bar face (~75 km; `sim/atmosphere.ts crushDepth`), where
  `sim/flight.ts collide` destroys the ship. The air's density and pressure keep rising under the
  face down to it (e^(−h/H)): drag and heating thicken as you go down. The flight panel's AIR line
  shows how near the limit you are from half of it (`HULL LIMIT 63 %`), amber from 80 %.

