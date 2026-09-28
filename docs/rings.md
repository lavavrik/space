# Rings

Gas and ice giants can have rings (`universe/system.ts`: an inner and outer radius in planet radii, a colour and a seed). From afar a ring is a textured disc; up close it's a belt of rock you can fly through.

## Density (`sim/rings.ts ringDensity`)

Both views read the same density across the radius: bands from two octaves of simplex noise, soft inner and outer edges, and a Cassini-like division 63 % of the way out. The disc's shader (`render/shaders/ring.frag.glsl`) uses it as opacity; the rock field uses it (over its peak) for how full each cell is, so a dark gap in the disc is an empty lane among the rocks.

## The rocks (`render/RingField.ts`)

- **All on the GPU.** Each layer (`ROCK_LAYERS`) is a grid of cells centred on you in the ring's co-orbiting frame, a few candidate rocks per cell spread through the belt's thickness (±1.5 km: `RING_HALF_THICK`; real rings are tens of metres thick, this one reads as a belt). The vertex shader works out a rock's cell from its instance (or vertex) index, and from a hash of the cell's global indices its place, size, tint, orientation and whether it's there at all (the ring's density), so the same rocks are there every visit. The CPU only fills a small table per radial bin each frame: its offset from your radius, where you are in its co-orbiting frame (in double precision: rings are ~10⁸ m out), its density.
- **They orbit.** Each radial bin turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks overtake outer ones. Match the ring's orbit and your neighbours drift by at walking pace; hover still over the planet and they stream past at tens of km/s (the autopilot's equatorial orbit at the ring's height is the way to fly among them).
- **Layers:**

| Layer | Rock radius | Out to | Grid, per cell | Drawn as |
|---|---|---|---|---|
| pebbles | 1.5–10 m | 3 km | 128², 3 | meshes (fine within 300 m) |
| rocks | 10–70 m | 25 km | 128², 3 | meshes (fine within 3 km) |
| boulders | 70–500 m | 150 km | 128², 4 | meshes (fine within 10 km) |
| boulder specks | 70–500 m | 600 km | 256², 16 | specks |
| far grain | 60–400 m | 12,000 km | 256², 14 | specks |

  Up to ~200,000 mesh rocks and ~1.3 million specks are candidates; most fall outside the density or range and cost only their vertex shader. Sizes favour the small end.
- **Meshes:** every rock has its own shape. The vertex shader pushes a unit icosphere out by three octaves of 3D noise at a per-rock offset, then elongates it (a random 1 : 0.55–0.95 : 0.45–0.9) and turns it by a random quaternion. Up close the same rocks switch to a finer sphere (`near`: pebbles within 300 m, rocks within 3 km, boulders within 10 km; the coarse copy skips them) with normals from the shape itself. The fragment shader adds fine relief (three octaves of bump-mapped noise, a few percent of the rock's size) and mottling, and lights them like regolith: Lommel–Seeliger (the Moon's flat-looking disc) mixed with a little Lambert, dark in the planet's shadow, plus planetshine from the giant's sunlit face. They shrink away over the outer half of their range.
- **Specks:** the boulder specks carry on the boulders' own population (same sizes, the same number per area) and fade in over 75–150 km as the boulder meshes shrink away, so there's no step where meshes turn to specks. A speck is never drawn wider than 2 px (bigger dots read as flat discs); above that it's brightened to keep the light of the rock it stands for, below a pixel it's dimmed by its share of one.
- **The disc near you:** inside the belt the disc fades out within 540 km of you (`DISC_FROM`): rocks and specks around you, and beyond, the disc's bands with the far grain on them. Above or below the belt it comes back (fully 6 km out of it), since it stands for all the rocks too small or far to draw.
- **Cost:** 3.5–4.5 ms for the whole frame in the belt here, almost all of it on the GPU.

## Flying in the belt

- **Ring orbit** (orbit planner, O, then 5; HX-8200 and up): a circular orbit in the ring's plane at a radius within it, going the ring's way round, so the rocks around you move with you. It starts at your own radius if you're inside the ring, else at its densest band; [ ] move it across the ring by 1 % of its width (Shift: 10 %), and the planner says whether that's a gap, a sparse band or dense rock. The autopilot flies there like any orbit (an FTL leg if it's far), trims into it and coasts. From Venydes' home planet to Venydes 8's ring: about 3½ minutes, arriving under 1 m/s from the rocks.
- **Ring frame** (`sim/frame.ts ringFrameOf`): inside a belt (within 20 km of its thickness and span), flight assist, the speed readout ("REL. RING") and the speed limit work relative to the rocks where you are: their circular orbit speed there. Hands off, you drift along with them and hold your height in the belt (about 1 kg of propellant every couple of minutes for the small corrections); thrust moves you among them. The influences panel (B) shows it as the flight-assist frame.
- **Belt speed limit:** 800 m/s (2,400 m/s with boost) while flight assist is on in a belt (`flight.ts BELT_MAX`), slow enough to pick a way among the rocks; the speed bar says BELT LIMIT.
- **Approach strip:** a ringed world's ring edges are marked (RING, RING IN).

Not yet: collisions with the rocks, and rocks as radar contacts or mining targets (SPACE-56).
