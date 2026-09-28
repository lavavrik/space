# Rings

Gas and ice giants can have rings (`universe/system.ts`: an inner and outer radius in planet radii, a colour and a seed). From afar a ring is a textured disc; up close it's a belt of rock you can fly through.

## Density (`sim/rings.ts ringDensity`)

Both views read the same density across the radius: bands from two octaves of simplex noise, soft inner and outer edges, and a Cassini-like division 63 % of the way out. The disc's shader (`render/shaders/ring.frag.glsl`) uses it as opacity; the rock field uses it (over its peak) for how full each cell is, so a dark gap in the disc is an empty lane among the rocks.

## The rocks (`render/RingField.ts`)

- **Generated, not stored.** The ring is cut into cells in its own co-orbiting frame: radial bins, and in each, bins about a cell long along the orbit, and bins through its thickness (±1.5 km: `RING_HALF_THICK`; real rings are tens of metres thick, this one reads as a belt). Each cell's rocks come from a hash of its indices and the ring's seed: the same rocks every visit.
- **They orbit.** Each radial bin turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks overtake outer ones. Match the ring's orbit and your neighbours drift by at walking pace; hover still over the planet and they stream past at tens of km/s.
- **Four tiers** (`ROCK_TIERS`): pebbles 1.5–10 m out to 2.5 km, rocks 10–70 m out to 12 km, boulders 70–500 m out to 60 km (all as meshes), and a far field of 100–800 m rocks as dots out to 250 km, each sized by how big it would look and dimmed below a pixel. So the grey band only starts where even the biggest rock is under a pixel; before that, the band is individual rocks. Sizes favour the small end. Toward the edge of its range a rock shrinks away (a dot fades) instead of popping out.
- **Looks:** four lumpy shapes per mesh tier (an icosphere pushed in and out by noise, faceted; coarser for the smaller tiers), squashed and turned at random, tinted from the ring's colour, lit by the star and dark in the planet's shadow. Instanced (up to 4,000 / 2,500 / 800 of each shape per tier, 30,000 dots).
- **Cached cells:** each cell's rocks are generated once and kept in its co-orbiting frame (offset, angle within the cell, height, orientation × size); a frame only turns each radial bin by its orbit and subtracts the camera.
- **The disc near you:** inside the belt, the disc fades out within 225 km of the camera, so it's rocks around you and the disc's bands further off. Above or below the belt it comes back (fully 6 km out of it), since it stands for all the rocks too small or far to draw, or you'd look down through a hole of sparse boulders.
- **Precision:** positions are worked out in double precision relative to the planet (rings are ~10⁸ m out) and handed to the GPU relative to the camera. Co-orbiting at 33 km/s, a rock moves about 1 cm a frame against you, without jitter.
- **Cost:** in the belt, ~4,000 mesh rocks and ~5,000 dots: about 1 ms of CPU a frame to lay them out and ~3–5 ms of GPU for the whole frame here. Only while you're in or near a ring.
- **Speed:** they really are fast. A ring orbits at tens of km/s; hover still over the planet and the belt streams past at that speed. Match its orbit (the autopilot's equatorial orbit at the ring's height) to drift among them.

Not yet: collisions with the rocks, and rocks as radar contacts or mining targets.
