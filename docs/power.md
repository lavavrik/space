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

## Oxygen and fuel cells (`sim/oxygen.ts`)

The ship carries a 2 t tank of liquid oxygen (LOX, at 90 K, 1.14 kg/L), with its own gauge (O₂).

- **Life support** breathes 2 kg a day: a crew of 4 at 0.84 kg each, with about half won back from the CO₂, as on the ISS.
  - A full tank lasts about 1,000 days on breathing alone.
  - Docked, the station supplies the air.
  - You're warned at 3 days left. An empty tank is fatal.
- **Fuel cell** (a module, a reserve generator: FC-50 Ember 50 kW / 0.9 t, FC-150 Hearth 150 kW / 2.5 t; the new ship has the FC-150 in a 7th slot):
  - It works like the Apollo and Shuttle cells: H₂ + ½O₂ → water and electricity, at 55 % of hydrogen's heating value. That's 18.3 kWh per kg of H₂, taking 7.94 kg of O₂ each. The other 45 % is heat in the hull.
  - It starts on its own when the battery falls under 30 % and stops over 80 %. It covers the loads the panels can't and recharges the battery, up to its rating. It has a switch on the power schematic.
  - While it runs you see: a flask lamp on the dashboard (its tooltip gives output and O₂ burn), "fuel cell +N kW" on the battery gauge, its burn rate and time left on the O₂ gauge, a message when it starts, and its box on the power schematic.
  - At 150 kW it burns 8.2 kg of H₂ and 65 kg of O₂ an hour, so a full tank lasts ~31 hours. The hydrogen barely registers; the oxygen is the limit.
- **Oxygen comes from:**
  - Stations: 0.3 Cr/kg, on the Services tab's slider (a full tank ~600 Cr).
  - Water, split by the electrolyser (below).
  - Air: skimming an Earth-like world's atmosphere with the fuel scoop catches its oxygen (23 % of air by mass), in proportion to the air's density and your speed through it. The richest pickings are low and fast, where the entry heating is too.
- **Water and the regenerative loop:**
  - A 3 t water tank takes the fuel cell's exhaust (9 kg of water per kg of H₂ burned) and ice while mining (2 kg/s while the laser boils a rock or you mine ice on the ground).
  - The electrolyser (300 kW, a load on the schematic) splits it back into hydrogen, to the propellant, and oxygen, at 5.56 kWh per kg of water (~50 kWh per kg of H₂). That's ~48 kg of O₂ an hour.
  - It runs on spare power only: never from a battery under half, and never while the fuel cell runs (the two would feed each other).
  - So fuel cell plus electrolyser is a regenerative fuel cell: spare sunlight stored as H₂ + O₂ and burned back when power runs short. The round trip is ~37 % (18.3 kWh back of every 50 spent), as real ones manage. Heavy, lossy, but large storage.
- **Cryocoolers** (a load, ~7 kW, switchable and shed at a low battery) keep the liquid hydrogen (20 K) and oxygen (90 K) cold.
  - They pump out the heat leaking in through the tanks' insulation from the hull: ~80 W into the LH₂ tank and ~4 W into the LOX at a 290 K hull, more the hotter it gets. Pumping heat out at 20 K takes ~90 W of power per W.
  - What they can't hold off boils off and is vented: ~16 kg a day with them off at 290 K. You're warned, and the O₂ gauge shows it.
- (The scoop's hydrogen from ice isn't charged the electrolysis energy it would really need. The propellant yields were tuned for play before oxygen existed. Oxygen is charged in full.)

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
