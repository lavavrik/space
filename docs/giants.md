# Gas and ice giants

Their face is their cloud tops, drawn in the planet shader (`planet.wgsl giantSurface`). You can't
descend into one (you're crushed), so there's no volumetric layer: from orbit what matters is
motion and structure.

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
