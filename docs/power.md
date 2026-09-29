# Power

Everything electrical draws from one bus (`sim/power.ts`). Each frame, the bus can supply the
solar panels' output plus the battery's discharge limit, while the battery holds charge.

## Loads

Loads are granted in this order:

| Load | Asks for | Short of it |
|---|---|---|
| Life support, avionics | 40 kW | always on |
| Drive charging | FTL 6 MW (5 kWh), hyperdrive 25 MW (~35 kWh) | Charges slower. The energy is fixed, so charge time = energy ÷ power granted. |
| FTL drive | 600 kW | Drops out ("Power failure"). |
| Thrusters | 1.2 kW per m/s² | Thrust is capped. |
| Heat pump | up to 2 MW | Runs at whatever is left (`sim/thermal.ts`). |

The first load that gets less than it asked for is reported on the HUD (note line, speedometer
charge readout) and in the ship stats panel (U → Electrical).

## Switches

Ship stats (U) draws the bus as a schematic, and every load you can switch off has a switch on it (`sim/power.ts toggleLoad`): headlights (also Shift+L), thrusters, the FTL drive, drive charging, the heat pump (its thermostat; also in the outfit panel) and the radar. Life support and avionics can't be switched off. Off, a load draws nothing and doesn't work:

- thrusters: no thrust at all, for you, the autopilot and the docking computer; flight assist can't hold you, so you coast and fall;
- FTL drive: won't charge or start, and drops you out if it's running;
- drive charging: an FTL or hyperdrive charge pauses where it is;
- radar: can't sweep (a sweep in progress pauses).

The switches are saved with the ship. Later they may become power shares instead of on/off, to direct a weak bus where it matters.

## Load shedding (`loadShed`)

In flight, when the battery drops below 10 %, everything except life support, the thrusters and the
FTL drive (with its charging) is switched off:
- the mining laser and headlights;
- the radar;
- the belt's deflector and collision radar;
- the heat pump.

A message lists what went off. Those loads come back on above 30 % or when docked. Loads that were
already off stay off.

It acts only when the battery crosses the line, so a load you switch back on by hand while the
battery is low stays on. The trade-off: the hull may heat up without the pump, and the belt
protection is off.

## Battery

The battery settles each frame after the loads:
- **Deficit:** covered from the battery, never more than its discharge limit.
- **Surplus solar:** charges it, up to its charge acceptance. Anything beyond that is curtailed.

| Battery | Capacity | Discharge | Charge | Mass |
|---|---|---|---|---|
| EB-200 Cell (stock) | 200 kWh | 1 MW (5C) | 200 kW (1C) | 1.3 t (part of the hull's 80 t) |
| EB-500 Reservoir | 500 kWh | 2.5 MW (5C) | 500 kW | 3.2 t |
| HP-300 Surge (titanate) | 300 kWh | 9 MW (30C) | 3 MW (10C) | 3.8 t |
| HP-600 Tempest (titanate + supercaps) | 600 kWh | 30 MW (50C) | 6 MW | 7.5 t |

Batteries are swapped alongside a station (Shift+U). The yard fits the new pack fully charged.
Extra mass over the stock pack counts toward the dry mass.

## Charge times

Checked in the sim with the panels dark, so the bus is the battery alone:

| Battery | FTL charge | Hyperjump charge |
|---|---|---|
| EB-200 (1 MW) | ~19 s | ~130 s |
| HP-300 (9 MW) | 3 s (full rate) | ~14 s |
| HP-600 (30 MW) | 3 s | 5 s (full rate) |

With the panels on the star, add up to 1.5 MW to the bus.
