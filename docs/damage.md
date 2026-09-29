# Damage and repair

The hull has a structural integrity, 0–100 % (`Ship.hull`; `sim/damage.ts`). At 0 the ship is
lost. It's shown as INTEGRITY in the ship panel, under the hull temperature, with what's wearing it
or where to mend it. It's saved with the ship; a replacement ship starts sound, and is never delivered inside a ring's belt
(at least 50 km off its slab: at rest there the rocks stream past at km/s).

## What wears it

- **Impacts** (`impactDamage`): nothing below a scrape speed; above it the damage grows with the
  square of the excess speed (the energy), up to a whole hull's worth at the speed that used to be
  instantly fatal. A sound hull survives anything a little under that; a battered one may not.

  | What | Scrape (m/s) | Whole hull (m/s) | e.g. |
  |---|---|---|---|
  | The ground (`flight.ts collide`) | 10 | 150 (CRASH_SPEED) | 30 m/s: 2 %, 80 m/s: 25 % |
  | A station's structure (`docking.ts stationContact`) | 3 | 35 | 10 m/s: 5 %, 21 m/s: 32 % |

  A knock of 1 % or more is reported ("Hit … · hull damage · integrity"), replacing the touchdown
  or contact message.
- **Heat** (`heatDamageRate`): above TEMP.critical (800 K) the structure weakens, (ΔT/100 K)² × 3 %/s,
  so 0.75 %/s at 850 K and 3 %/s at the failure point (900 K, which still fails at once).

Crossing 50 % and 25 % integrity gives a warning to dock for repairs.

## Repair

Docked, the station repairs the hull (the docked panel's "repair hull"; free until there's an
economy, SPACE-51). Traffic ships are repaired with their refuel.

## Next

- Ring rocks (SPACE-56) and belt protection (SPACE-57): impacts through `impact()`, with armour or a
  deflector lowering the damage.
- Effects short of loss (a damaged hull leaking heat or propellant, weaker thrusters).

## Wrecks and salvage (`sim/wreck.ts`)

Losing a ship with metal in its hold leaves a **wreck**.
- **Its beacon:** a blinking red × with the metal aboard and the distance, marked from anywhere in the system.
  - It can be targeted like anything else (T, G, click), with a target card and an info panel (I) listing the metal and where it is.
  - Behind a world it isn't drawn, like a ship.
- **Where it goes:** in space it falls on along the path the ship had, round the world it was nearest (leapfrog in 2 s steps, patched conics like the ship). A wreck in orbit stays in orbit; one flung off a station drifts away. One that came down on a world (or falls into it) rests where it hit, turning with the world. One that fell into a star is gone.
- **Salvage:** come within 150 m and match its speed (under 10 m/s). The metal moves across into your hold, as much as there's room for; what's left stays aboard. A stripped wreck is gone.
- **What isn't salvaged:** contract crates. The client writes them off with the ship, and the haul fails as before.
- **How many:** the newest 3 wrecks are kept (all systems), saved with the game. The replacement ship's message points at the wreck.
