# Rings

Gas and ice giants can have rings (`universe/system.ts`: an inner and outer radius in planet radii, a colour and a seed). From afar a ring is a textured disc; up close it's a belt of rock you can fly through.

## Density (`sim/rings.ts ringDensity`)

Both views read the same density across the radius: bands from two octaves of simplex noise, soft inner and outer edges, and a Cassini-like division 63 % of the way out. The disc's shader (`render/shaders/ring.frag.glsl`) uses it as opacity; the rock field uses it (over its peak) for how full each cell is, so a dark gap in the disc is an empty lane among the rocks.

## The rocks (`render/RingField.ts`)

- **Generated, not stored.** The ring is cut into cells in its own co-orbiting frame: radial bins, and in each, bins about a cell long along the orbit, and bins through its thickness (±1.5 km: `RING_HALF_THICK`; real rings are tens of metres thick, this one reads as a belt). Each cell's rocks come from a hash of its indices and the ring's seed: the same rocks every visit.
- **They orbit.** Each radial bin turns at the circular orbit rate at its radius, so the ring shears like a real one: inner rocks overtake outer ones. Match the ring's orbit and your neighbours drift by at walking pace; hover still over the planet and they stream past at tens of km/s.
- **Two tiers** (`ROCK_TIERS`): rocks 2–30 m across in 400 m cells out to 5 km, and boulders 40–400 m in 4 km cells out to 40 km. Sizes favour the small end. Toward the edge of its range a rock shrinks away instead of popping out.
- **Looks:** four lumpy shapes (an icosphere pushed in and out by noise, faceted), squashed and tumbling slowly, tinted from the ring's colour, lit by the star and dark in the planet's shadow. Instanced: at most 3,000 of each shape.
- **The disc near you:** inside the belt, the disc fades out within 36 km of the camera, so it's rocks around you and the disc's bands further off. Above or below the belt it comes back (fully 6 km out of it), since it stands for all the rocks too small or far to draw, or you'd look down through a hole of sparse boulders.
- **Precision:** positions are worked out in double precision relative to the planet (rings are ~10⁸ m out) and handed to the GPU relative to the camera. Co-orbiting at 33 km/s, a rock moves about 1 cm a frame against you, without jitter.
- **Cost:** ~1.2 ms of CPU a frame to lay out ~3,000 rocks, only while you're in or near a ring.

Not yet: collisions with the rocks, and rocks as radar contacts or mining targets.
