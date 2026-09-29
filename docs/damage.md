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
