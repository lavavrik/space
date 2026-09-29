# Economy

First step (SPACE-51): credits, paid station services, a cargo hold and metals to sell.
Code: `sim/economy.ts`; prices in `outfit/catalog.ts` (modules) and `PRICE`/`COMMODITIES`.

## Credits

- Yours, not the ship's (`Game.credits`, saved): a replacement ship keeps them. You start with
  25,000 Cr and the fully kitted ship. Shown under the CARGO gauge and in the docked panel.
- Every station's prices differ a little, ±20 %, per item (a hash of its name and the item): worth
  shopping round, the same every visit.

## The station window (docked; `ui/components/StationPanel.tsx`)

It opens on docking, and on loading a game that was docked, in place of whatever was in the left column. It has four tabs:
- **Trading:** the metal in your hold at this station's prices, each marked against the list price (±20 %, a hash of the station: worth shopping round). Sell one metal or all of it.
- **Services**, in groups ruled off from each other:
  - credits;
  - hydrogen and exotic matter, each bought on its own up to a level picked on a slider (the cost shows as you drag), or filled up;
  - the hull and its repair;
  - the station (shore power, cooling);
  - leaving (launch; lift off or the catapult at a sky station).
- **Contracts:** the station's job board and your jobs. Shift+J while docked opens this tab.
- **Outfitting:** refit the utility slots and the battery from its catalogue. Shift+U while docked opens this tab.

It opens on Trading when there's metal in the hold, otherwise on Services.

Every tab has the same width: the left column keeps the scrollbar's room whether a tab scrolls or not (`scrollbar-gutter: stable`).

Icons (Phosphor, `ui/components/icons.ts RESOURCE_ICONS`):
- hydrogen is a drop (it's stored liquid);
- exotic matter is an atom;
- credits are coins;
- the hold is a crate.

They appear on the ship gauges, in the cargo, contracts and station windows.

Job boards show the time a job gives you once taken ("35 min to deliver once taken"), not a countdown, plus when the next board comes. Your own jobs count down.

## Services (the station window's Services tab, with the price at this station)

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
- **Cargo window (Shift+I**, or "cargo" in the docked panel; `ui/components/CargoPanel.tsx`):
  - The hold as one stacked bar, with a colour per metal.
  - A line per metal: mass, price and value. Prices are the docked station's, otherwise list prices.
  - Docked: sell one metal or the whole hold. In flight: jettison a metal to lighten the ship or make
    room. Jettisoning takes a second click within 3 s and is gone for good.
  - Below: the tanks, the ship's mass, and Δv left, with how much less that is than with an empty hold.
  - While the laser cuts: its metal catch per second.

## Contracts (`sim/contracts.ts`; window: Shift+J, or "job board" when docked)

Every station has a job board of 4 offers. It's the same for anyone who looks for 30 minutes of sim time (a hash of the station and the period), then a new one comes up. A job you've taken or finished isn't offered again on that board.

| Job | What | Pay | Time |
|---|---|---|---|
| **Haul** | 5–60 t of crates to another station: in this system (60 %) or one within 15 ly | 1,500 + 1,500/AU + 40/t in system; 4,000 + 1,200/ly + 60/t to another | 20 min + 5 min/AU, or 25 min + 5 min/ly |
| **Courier** | a data packet (no mass) to a station in another system | 3,000 + 1,500/ly | 10 min + 2.5 min/ly: tight |
| **Metal order** | this station wants an amount of one metal (up to 2 t of platinum, 15 t of cobalt, 80 t of nickel-iron) | 2–3× its list price + 500 | 2–4 h |

- **Holding jobs:** you can have up to 3 at once.
  - Haul crates go in the hold (`Ship.crates`). They count in the ship's mass and use its room, so a haul needs space.
- **Getting paid:**
  - Hauls and courier runs pay when you dock at the destination.
  - Metal orders are handed over from the hold with "deliver", docked at the station that asked, once you have enough.
- **Finding the way:** "plot route" has the nav computer plan the way to the job's destination (for a metal order, the station that placed it): jumps if it's in another system, then a rendezvous with the station. Enter in the nav panel flies it. A station in this system is targeted too.
- **Failing:** a job past its deadline fails. Its crates are taken back and you pay 25 % of its reward, as far as your credits go. Abandoning (a second click) costs the same. You get a warning 5 minutes before a deadline.
- **Losing the ship** loses the crates, so hauls fail. Courier runs and metal orders carry on.
- **Scale:** a job pays about what 10–30 minutes of mining would. A platinum order can pay ~50,000 Cr, but you have to find and mine a platinum-rich rock first.
- Jobs and the board history are saved.

## Not yet

Buying and hauling commodities between stations (supply and demand), ship purchases, fines or
insurance, other ships trading.
