# Economy

First step (SPACE-51): credits, paid station services, a cargo hold and metals to sell.
Code: `sim/economy.ts`; prices in `outfit/catalog.ts` (modules) and `PRICE`/`COMMODITIES`.

## Credits

- Yours, not the ship's (`Game.credits`, saved): a replacement ship keeps them. You start with
  25,000 Cr and the fully kitted ship. Shown under the CARGO gauge and in the docked panel.
- Every station's prices differ a little, ±20 %, per item (a hash of its name and the item): worth
  shopping round, the same every visit.

## Services (docked panel, with the price at this station)

| | List price | |
|---|---|---|
| Propellant | 0.1 Cr/kg | a full 120 t tank ~12,000 Cr |
| Exotic matter | 60 Cr/kg | a full 100 kg ~6,000 Cr |
| Hull repair | 120 Cr per % | a whole hull ~12,000 Cr |
| Tanker (Shift+K) | 2,500 Cr call-out + fuel at 1.5× | the battery's charge comes free |

What you can't afford, you get as much of as your credits buy (fuel propellant first). Shore power
and hull cooling are free. Fuel you gather yourself is free: corona and gas-giant scooping, ice on
the ground, the mining laser.

## Outfitting

Fitting a module costs its price there (list × the station's factor); one taken out, or replaced,
is bought back at half its list price (the battery too). List prices: radiators 12k/24k, scoops
15k/30k/60k, heat pump 18k, deflectors 20k/45k, collision radars 8k/22k, mining lasers 15k/40k,
batteries 4k/12k/25k/60k.

## Cargo and metals

- A 200 t hold (`Ship.cargo`, saved; lost with the ship). Its load counts in the ship's mass: a full
  hold more than doubles the empty ship's 80 t, and Δv drops to match.
- The mining laser's scoop catches a little of the metal in the rock it breaks up (1 part in 10,000
  of the metal in what it scatters), split 90 % nickel-iron, 9 % cobalt, 1 % platinum-group metals.
- Most ring rocks are 90–99 % ice with a trace of metal (~0.7 kg/s under the ML-6). One in 30 is a
  metal-rich rock (25–55 % metal, little ice): ~30 kg/s, ~2 t (~500 Cr) a minute, but little
  propellant; the hold fills in about two hours of it. The laser's target readout shows the make-up: prospect before you fire.
- Sold at any station (docked panel: "sell the hold"): nickel-iron 0.05, cobalt 1, platinum-group
  metals 10 Cr/kg list (≈ 0.24 Cr per kg of mixed metal, ~47,000 Cr for a full hold). The first
  prices were 40× this: a 20 t hold paid ~200,000 Cr.

## Not yet

Buying and hauling commodities between stations (supply and demand), ship purchases, fines or
insurance, other ships trading.
