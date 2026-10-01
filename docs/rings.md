# Rings

Gas and ice giants can have rings (`universe/system.ts`: an inner and outer radius in planet radii, a colour and a seed). From afar a ring is a textured disc; up close it's a belt of rock you can fly through.

## Density (`sim/rings.ts ringDensity`)

Both views read the same density across the radius: bands from two octaves of simplex noise, soft inner and outer edges, and a Cassini-like division 63 % of the way out. The disc's shader (`render/shaders/ring.frag.glsl`) uses it as opacity; the rock field uses it (over its peak) for how full each cell is, so a dark gap in the disc is an empty lane among the rocks.

## The ring disc's light (`gpu/shaders/ring.wgsl ringLight`)

How a ring's particles send a sun's light to you, × their colour:

- **From the lit side**, reflected (by the sun's height over the plane), brighter still with the sun right behind you (the opposition surge: no shadows to see).
- **From the unlit side**, only what comes through: thin parts glow, thick ones go dark.
- **Forward scattering:** fine dust scatters forward (Henyey-Greenstein, g 0.75), so looking toward the sun the thin, dusty parts blaze, as Saturn's rings seen from behind it. Both suns of a pair.
- The world's shadow still falls across it.

## The rocks (`render/RingField.ts`)

- **All on the GPU.** Each layer (`ROCK_LAYERS`) is a grid of cells centred on you in the ring's co-orbiting frame, a few candidate rocks per cell spread through the belt's thickness (±1.5 km: `RING_HALF_THICK`; real rings are tens of metres thick, this one reads as a belt). The vertex shader works out a rock's cell from its instance (or vertex) index, and from a hash of the cell's global indices its place, size, tint, orientation and whether it's there at all (the ring's density), so the same rocks are there every visit. The CPU only fills a small table per radial bin each frame: its offset from your radius, where you are in its co-orbiting frame (in double precision: rings are ~10⁸ m out), its density.
- **Small angles:** a rock's angle round the ring from you is its distance over the ring's radius, ~10⁻⁶ rad. Its sine and cosine are taken by their series (`rock.wgsl sinT`, `cosT`), not the built-in `sin`, which on NVIDIA under D3D is accurate only to ~10⁻⁶ absolute: there the rocks jumped between quantised places as you moved, like a slideshow (Apple's GPUs were fine).
- **Wrapping:** a whole number of cells goes round each radial bin, and a rock's angular index wraps at it, so when a bin's phase wraps by a full turn (every orbit; every few seconds under time warp) every rock stays put. Before, a turn was a fraction of a cell off, and each wrap swapped a bin's rocks for a different set: under warp, rocks vanished a band at a time. Indices past float32's exact integers (the smallest cells round a giant's outer ring number tens of millions) go to the GPU split in two.
- **They orbit.** Each radial bin turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks overtake outer ones. Match the ring's orbit and your neighbours drift by at walking pace (under time warp, visibly: rocks nearer the planet pull ahead and those further out fall behind, real Keplerian shear); hover still over the planet and they stream past at tens of km/s (the autopilot's equatorial orbit at the ring's height is the way to fly among them).
- **Layers:**

| Layer | Rock radius | Out to | Grid, per cell | Drawn as |
|---|---|---|---|---|
| pebbles | 1.5–10 m | 6 km | 256², 3 | meshes (fine within 500 m) |
| rocks | 10–70 m | 50 km | 256², 3 | meshes (fine within 4 km) |
| boulders | 70–500 m | 300 km | 256², 4 | meshes (fine within 10 km, medium to 40 km) |
| boulder specks | 70–500 m | 600 km | 256², 16 | specks |
| far grain | 60–400 m | 12,000 km | 256², 14 | specks |

  The mesh layers reached half as far (on 128² grids: the same cells, so the same rocks); twice as far cost ~1.5 ms more of GPU on an M5 Pro in the belt. Up to ~800,000 mesh rocks and ~1.3 million specks are candidates; most fall outside the density or range and cost only their vertex shader. Sizes favour the small end.
- **Meshes:** every rock has its own shape. The vertex shader pushes a unit icosphere out by three octaves of 3D noise at a per-rock offset, then elongates it (a random 1 : 0.55–0.95 : 0.45–0.9) and turns it by a random quaternion. Each layer is drawn in detail levels of the same rocks by distance (`lods`): pebbles fine within 500 m, rocks within 4 km, boulders within 10 km then medium to 40 km; beyond, a plain 12-vertex icosahedron. Normals come from the shape itself (finite differences on the sphere). The fragment shader adds fine relief (three octaves of bump-mapped noise, a few percent of the rock's size) and mottling. Where the noise is magnified (a texel over a few pixels, under the periscope) it's filtered at full precision in the shader: the GPU's own filtering has 8-bit weights, which showed as square blocks and moiré. Elsewhere the cheap hardware filtering does. The lighting is regolith-like: Lommel–Seeliger (the Moon's flat-looking disc) mixed with a little Lambert, dark in the planet's shadow, plus planetshine from the giant's sunlit face. They shrink away over the outer half of their range.
- **Specks:** the boulder specks carry on the boulders' own population (same sizes, the same number per area) and fade in over 150–300 km as the boulder meshes shrink away, so there's no step where meshes turn to specks. A speck is never drawn wider than 2 px (bigger dots read as flat discs); above that it's brightened to keep the light of the rock it stands for, below a pixel it's dimmed by its share of one.
- **The disc near you:** inside the belt the disc fades out within 540 km of you (`DISC_FROM`): rocks and specks around you, and beyond, the disc's bands with the far grain on them. Above or below the belt it comes back (fully 6 km out of it), since it stands for all the rocks too small or far to draw.
- **Cost:** the ring itself is about 3–4 ms of GPU here (2.4 without the surface relief). Most of it is vertex work: every candidate rock runs the shader for every vertex of its mesh, which is why the far detail level is a 12-vertex shape (the distant boulders alone were 2.5 ms at 42 vertices).

## Flying in the belt

- **Ring orbit** (orbit planner, O, then 5; HX-8200 and up): a circular orbit in the ring's plane at a radius within it, going the ring's way round, so the rocks around you move with you. It starts at your own radius if you're inside the ring, else at its densest band; [ ] move it across the ring by 1 % of its width (Shift: 10 %), and the planner says whether that's a gap, a sparse band or dense rock. The autopilot flies there like any orbit (an FTL leg if it's far), trims into it and coasts. From Venydes' home planet to Venydes 8's ring: about 3½ minutes, arriving under 1 m/s from the rocks.
- **Ring frame** (`sim/frame.ts ringFrameOf`): inside a belt (within 20 km of its thickness and span), flight assist, the speed readout ("REL. RING") and the speed limit work relative to the rocks where you are: their circular orbit speed there. Hands off, you drift along with them and hold your height in the belt (about 1 kg of propellant every couple of minutes for the small corrections); thrust moves you among them. The influences panel (B) shows it as the flight-assist frame.
- **Under time warp** in a belt, drifting under 5 m/s against the rocks, the ship is held exactly on their orbit (`update.ts RING_SNAP`). A leftover m/s (the autopilot settles within 1) swings you round a loop of about ±10 km about your spot once an orbit: invisible in real time (a 7-hour cycle), but at 1,000× the whole field slid back and forth and the belt seemed to squeeze and stretch.
- **Belt speed limit:** 800 m/s (2,400 m/s with boost) while flight assist is on in a belt (`flight.ts BELT_MAX`), slow enough to pick a way among the rocks; the speed bar says BELT LIMIT.
- **Approach strip:** a ringed world's ring edges are marked (RING, RING IN).

## Collisions (`sim/ringRocks.ts`, `sim/ringContact.ts`)

- **The same rocks on the CPU.** `rocksNear` is an exact replica of the GPU generator: the same
  integer hash (pcg3) and random stream (PCG-RXS-M-XS) in 32-bit maths, float32 rounding where the
  GPU rounds, the same bins, cells and wrap. Checked by pointing the camera at a predicted 70 m rock
  from 350 m: it was dead centre, the right size. Only the three mesh layers count (pebbles, rocks,
  boulders); the speck layers are the same boulders far away.
- **Sweep.** Each step, the ship's path is swept against the rocks round it (each rock's own orbital
  motion over the step taken out): the earliest touch wins. ~0.05 ms a step, at any speed up to
  tens of km/s.
- **The ship's size** is its cross-section along its motion through the rocks: ~6 m across
  nose-first, ~15 m side-on. Crossing 25 km of a dense band nose-first at up to 800 m/s met nothing;
  side-on at 100 m/s, one pebble in 2 km (11 %).
- **Damage** is the closing speed scaled by the reduced mass (`effectiveSpeed`: a 2 m pebble counts
  ~0.35 of its speed, a boulder like the ground), through `sim/damage.ts` (scrape 3 m/s, a whole
  hull at 150 m/s). Rocks are 1,500 kg/m³, half an ellipsoid's worth of their size.
- **Response.** A rock lighter than the ship is knocked aside: the ship keeps going, less the
  momentum it gave up, and that rock is left out for 2 minutes (it can't really move: it's drawn
  from a hash; without this the ship stopped against a pebble and hit it again and again). A
  heavier one bounces the ship back to where it touched, with 30 % of the closing speed.
- **The ring orbit's autopilot** crosses into the slab at 15 m/s (braking to that by the slab's
  edge), so the pebble or two in its way are bumps: into dense bands it arrives with at most a few
  tenths of a percent of damage. If a heavy rock sits on its spot, it steps the orbit aside.
- **It never crosses the belt inside the slab.** Its FTL leg drops out 20 km off the ring's plane
  (dropping out in the plane left the ship at rest against rocks orbiting at 5 km/s: a wreck on
  arrival). Any radius change over 2 km is flown 1 km clear of the slab, on the side the ship is on.
  It only descends into the slab once it moves with the rocks (in-plane slip under 20 m/s). Smaller
  moves (stepping aside, the last trim) stay in the slab at 15 m/s.
- Not with time warp on (the ship is on the rocks' orbit then), nor for other ships yet.

## Protection (`sim/belt.ts`; modules in `outfit/catalog.ts`)

Two more utility slots (5 now) carry belt protection; a new ship has the best of each, and saves
from before get them fitted.

- **Dust erosion.** Inside the belt's slab, faster than 500 m/s through the rocks' frame, the hull
  wears at 0.004 × density × ((v − 500) / 1 km/s)³ per second (the dust's energy flux goes as v³):
  ~0.3–0.6 %/min cruising at the belt limit (800 m/s) in a dense band, ~6 % crossing the 3 km slab
  at 3 km/s, fatal across it at orbital speeds. The integrity gauge says when dust is wearing it.
- **Magnetic deflector** (Tessera Shielding MD-4 Aegis: stops 90 %, 800 kW; MD-8 Bulwark: 98 %,
  1.5 MW): draws its power only while there's dust to stop. Measured at 800 m/s in a dense band:
  0.295 %/min without, 0.006 %/min with the MD-8. A load in the power schematic (DEFLECTOR), with a
  switch.
- **Collision radar** (CR-2 Sentinel: rocks 10 m and up, 5 km ahead, warns; CR-5 Warden: every
  rock, pebbles 1.5 km ahead and bigger ones 8 km, and steers you clear): near a belt, every 0.25 s
  it looks along your motion through the rocks for any on a collision course (closest approach
  within touching + 30 m, up to 30 s ahead). The soonest is marked on the HUD (a blinking red ring
  with its size and seconds to contact; an edge arrow off screen) and in a ROCK pill, and a new
  one of 10 m or more is announced. A tracked rock stays tracked until it's passed. A load in the
  power schematic (COLLISION RADAR), with a switch.
- **Steering clear** (CR-5, flight assist on, not while you steer sideways or a computer flies):
  every threat pulls toward its own way clear (the short way, across the relative motion), weighted
  by how far short it is and how soon; the ship is pushed at 200 m/s² along the sum until each will
  miss by 15 m. Flight assist leaves the sideways drift alone until the rocks are passed (it used
  to damp the nudge straight back out). Flying at a 40–70 m rock at the belt limit, thrust held,
  from 3 km: 7 of 8 runs passed it and everything else untouched; without the radar, every run hit.
  It's help, not a guarantee.
- The impact messages give the real closing speed (the damage uses the mass-scaled one).
- Rocks are named by their size across (twice the drawn radius): a "50 m" label on a ~100 m rock
  read as far too small.
- A tracked rock is carried on along its orbit (turned about the ring's axis at its rate), not in
  a straight line: over 15 s the straight line drifted ~300 m off it, the marker slid off the rock,
  and its stale velocity made a stationary ship look like it was closing at tens of m/s. Closing
  slower than 2 m/s isn't a threat at all (below the scrape speed it's a harmless bump).

Not yet: other ships feeling any of this.

## Mining (`sim/laser.ts`, `render/Laser.ts`)

A mining laser in a utility slot (Tessera ML-2 Ablator: 200 kW, 600 m; ML-6 Sunspear: 600 kW, 1.5 km;
a new ship has the ML-6 in a 6th slot, and older saves get it fitted). Shift+M turns it on.

- **Aim with the nose.** The beam fires along it; the first rock in its path within range is hit,
  against the exact shape it's drawn with (`ringRocks.ts rockShape/rockRay`: the GPU's orientation,
  elongation and lumpy noise, from the same random draws and the same noise texture, marched along
  the beam): a sphere let the beam pass through a rock's long end, or stop short of its narrow side. Its ice boils off, the fuel scoop catches the vapour, and it's cracked
  into propellant (the H₂ gauge says "Laser mining a 96 m rock · 94 % ice").
- **Yield:** 600 kg/s per MW of beam, × the rock's ice fraction (from its id, like its shape: a
  giant's ring rocks are 90–99 % water ice), × a range factor (full out to a third of the range,
  none at it). The ML-6 at 300 m: ~340 kg/s, an empty tank in ~6 minutes. Tuned to be worth doing,
  not from the physics (really 600 kW would boil ~0.2 kg/s). Its draw was 10× this at first: it
  emptied the battery in 6 minutes.
- **Needs** a fuel scoop to catch the plume, and to hold still against the rock (under 50 m/s; the
  ring frame's flight assist does that hands off). The LASER pill says what it's yielding, or why not.
- **Costs:** its draw is a load on the bus (MINING LASER in the power schematic, switchable): the
  ML-6's 600 kW is under what the panels give in sunlight (up to 1.5 MW), and it all ends up as
  heat in the hull.
- **On screen:** the beam from under the nose (a camera-facing ribbon, never under ~2 px), a
  flickering white-hot spot where it hits, and a plume of vapour thrown off along the surface. The plume is kept relative to the rock's centre,
  so it stays where it was made however the beam wanders (it first followed the beam's end).
  Display-referred, out of the exposure meter.
- **Order:** it fires after the ship's move each step: mid-step the ship lags the rocks by its
  orbital motion (~700 m a frame round a giant), and a beam from there missed.
- **The target:** the rock the beam is on gets amber brackets with its size, distance, make-up
  (water ice 90–99 %, the rest silicate grit and a trace of metal: a hash of its id) and how much of
  it is mined away.
- **Rocks shrink.** The beam breaks up and scatters 2,000 kg of rock for every kg of propellant the
  scoop catches (most of what it frees is lost), so a rock loses mass and shrinks (size ∝ ∛mass):
  a 70 m rock lasts ~3½ minutes under the ML-6 (it filled a tank from 53 t on the way), ~100 m about
  8, pebbles a blink. Below 12 % of its size it's gone. Mined rocks are kept (`minedRocks`, saved
  with the game) by ring and rock id: the collisions, the radar and the laser see them shrunk or
  gone, and the renderer is told the nearest 24 per layer (`uMined`), which it draws shrunk or not
  at all.
- **Metals:** the scoop also catches a little of the metal in what the beam breaks up, and it goes
  into the hold (docs/economy.md). Each rock's metal has its own mix (`rockMake`):
  - **Icy rocks:** mostly nickel-iron, with 3–12 % cobalt and 0.2–1.2 % platinum-group metals.
  - **Metal-rich rocks (1 in 33):** 25–55 % metal and little ice, in three kinds:
    - nickel-iron (60 %): about 0.1–0.2 Cr/kg;
    - cobalt-rich (30 %): 20–35 % cobalt, about 0.4 Cr/kg;
    - platinum-rich (10 %): 4–12 % platinum-group metals, about 0.5–1.4 Cr/kg.

  The laser's readout shows the rock's kind and metal mix.
- **Metal-rich rocks look different.** Being metal-rich is decided by the rock's tint draw (under
  `METAL_RICH`), which the GPU and its CPU replica both compute. The renderer can therefore draw
  exactly those rocks as a darker warm grey, whatever the ring's colour, with glinting patches of
  bare metal.
- **Prospecting (`sim/prospect.ts`):** a radar sweep in a belt picks out the metal-rich rocks
  within 5 km (rocks) and 40 km (boulders). It keeps the best 6 and follows them round their orbits.
  - They're ranked by what an hour under your laser at close range would fetch, capped by the metal
    a small rock actually holds. The laser breaks rock up at a fixed rate, so a richer rock pays
    faster.
  - Ranking by the rock's whole metal put 1 km nickel-iron boulders, each holding thousands of
    tonnes, above everything else.
  - The finds are marked in the view (numbered diamonds coloured by metal) and listed in the radar
    window with Cr/h and Cr/kg.
  - A find is dropped once it's mined away, when a new sweep replaces the list, or when you're more than 80 km from it (twice the sweep's reach). Before that last rule they stayed marked for as long as you were near that planet.
  - A platinum-rich rock makes about 50–60,000 Cr/h under the ML-6, against about 10,000–20,000 for a
    nickel-iron one.
- **No FTL near the belt** (`sim/ftl.ts beltLock`): the drive won't start among a ring's rocks or within 10 km of their slab (off its plane or past its edges). The rocks are far outside the world's mass lock, so before this you could jump to FTL from among them. An autopilot setting off from the belt for somewhere far (not the ring orbit itself) first climbs straight out of the slab, at 15 m/s while among the rocks and then at 300 m/s, moving with them, and takes its FTL leg once clear.
- **The laser switches itself off** after 3 s with nothing in its beam (`LASER_IDLE`), whatever the ship is doing. When its rock is mined away it keeps firing, into the next rock if there's one right behind, else it switches off 3 s later. (At first it switched off the moment its rock was gone.)
- **Headlights (Shift+L) light the rocks.** They use the same lamp as on the stations
(`shaders/headlight.glsl`): a cone along the nose with inverse-square falloff. They're about as
bright as sunlight at 100 m, and they make rocks visible in the planet's shadow. Metal-rich rocks
glint in the beam too.
