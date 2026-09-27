# Ship temperature

The hull is one lumped heat capacity (`sim/thermal.ts`). In vacuum there is no air to carry heat
away, so the only loss is thermal radiation, εσAT⁴. Each frame the hull temperature moves toward
the point where that balances what comes in:

| Source | Model |
|---|---|
| Starlight | α · A⊥ · F, zero in a shadow. F = L/(4πd²); `power.flux` is F in Earth units (1361 W/m² at 1 AU from a Sun-like star). |
| Nearby worlds | (R/d)² · A/4 · (ε·σT_p⁴ + α·½·albedo·F_p): each world's infrared glow (T_p = its blackbody temperature from its own starlight) plus the light it reflects. Only counted within 30 radii, where it's over 0.1%. |
| Ship systems | Everything drawn from the power bus (life support, avionics, drive charging, the FTL drive) ends up as heat, except 95% of nozzle power, which leaves with the exhaust. |
| Out | ε σ A T⁴ over the whole hull. The 2.7 K sky is negligible. |

## The ship

| | |
|---|---|
| Shape | 60 m × 12 m cylinder along the nose axis |
| Radiating area A | 2,490 m² |
| Cross-section A⊥ | 113 m² nose- or tail-on, 720 m² side-on, in between by attitude |
| α / ε | 0.30 / 0.85 (white thermal paint) |
| Heat capacity | 80 t dry structure × 900 J/kg·K (≈ aluminium) = 7.2 × 10⁷ J/K. The hydrogen sits in insulated tanks and isn't counted. |

The time constant is C / (4εσAT³), about 3 hours near 1 AU. Nothing changes fast unless you are
very close to a star.

## Where it settles

These values are for a Sun-like star and were checked in the sim.

| Where | Starlight | Nose-on | Side-on |
|---|---|---|---|
| Home world (1.37 AU) | 0.54× | ~200 K | ~205 K |
| Hyperjump arrival (0.22 AU, ~46 R) | 20× | ~300 K | ~470 K, rising ~4.5 K/min at first |
| Corona scoop, full rate (0.1 AU, ~21 R) | 100× | ~445 K | ~705 K, rising ~24 K/min at first |
| 3 star radii | ~7,000× | — | hull fails in ~30 s |

## Limits

| Hull | Effect |
|---|---|
| 400 K | Warning |
| 500 K | Solar panels feathered edge-on to protect them: no solar power |
| 600 K | The FTL drive and hyperdrive can't be charged. A drive that is already running keeps going, so you can always leave. |
| 800 K | Structure weakening: red alarm |
| 900 K | Hull failure: the ship is lost (respawn as after a crash) |

## Distances by flux, not radii

Hyperjump arrival (`ARRIVE_FLUX` = 20× Earth) and the corona scoop band (from `SCOOP_FLUX_MIN` =
25× to full rate at `SCOOP_FLUX_FULL` = 100×) are set by starlight, via `fluxDist`. A hot B star
(thousands of L☉) is then no more dangerous to arrive at than a red dwarf. For the dimmest stars
there is a floor of 3 radii.

The scoop's rate follows the same 1/r² falloff as the starlight, because the density of the
corona and inner stellar wind falls off that way too. Nav-route refuel stops hold at the full-rate
distance with the nose on the star, tipped 10° so the panels on top still catch plenty of light.

## Not modelled (yet)

- Atmospheric entry heating.
- Radiators or heat sinks you can deploy.
- Separate panel temperature.
- Cold limits.
- Crew or cabin temperature (assumed to be held by life support).
