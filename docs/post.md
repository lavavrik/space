# Post-processing

After the scene (and the volumetric clouds, docs/clouds.md), in `gpu/post.ts`, `bloom.wgsl` and
the final pass `tonemap.wgsl`:

1. **Bloom:** light over 2 (display units: the star's disc and glow, signal lights, the laser,
   sparks and plasma; not a lit planet or a daylit sky) is kept by the first downsample (soft
   knee; each tap group weighted down by its brightness so single hot pixels don't flicker), then
   blurred wide through 6 half-size copies (13-tap down, tent up, each coarser level added into the next at 0.55 so a wide bright area doesn't glow far
   out (at full weight the low horizon's haze bloomed up into the sky); after
   Jimenez's Call of Duty: AW talk). The largest is added to the frame at 0.25.
   Both the bloom and the flare are made from the scene before the volumetric clouds are laid
   over it, so each is dimmed by what the clouds let through (the bloom where it lands, the flare
   at the star): the sun didn't glare through an overcast.
   Any tap that isn't a finite, non-negative number is taken as black. One NaN pixel, from any
   shader, was spread by the low mips into a black block a fifth of the screen across. On NVIDIA
   (D3D), the rocky moons' `pow` of a slightly negative value (planet.wgsl) blinked them.
- **Space warps (FTL in and out)** replace the white flashes they used to be (`tonemap.wgsl warpAt`, `gpu/post.ts warpsOf`).
  - **The effect.** The view bends round the drive's field as it forms or collapses, like a lens. A ring of squeezed space runs out from the centre and fades, with the colours slightly split at the bend and a faint cold shimmer. While the field is strong, the middle pinches light in, a bounded Einstein-ring-like bend (a plain 1/r knotted the centre).
  - **Your own** come centred on the view: engaging, dropping out, and arriving from hyperspace (stronger and longer: that one was the full-screen white flash).
  - **Other ships'** sit at their place on screen, 10,000 km across (their real size: a far one's is small), with a burst of light at the heart (half the size of the flash they had before). The nearest 8 are drawn at a time.
  - **Depth.** A warp bends only what's behind it: the final pass reads the scene's depth, kept for it while a warp is on. A rock in front of a ship dropping out stays as it is, and nothing in front is pulled in from beside it.
2. **Lens flare, from the star only:** four small tinted ghosts along the line from the star through
   A star's flare shows only while it's on screen, fading out over the last 5 % toward the edges. Off it, the flare read the frame at the nearest edge, which was bright sky, and its ghosts crossed the view from a sun you couldn't see.
   the screen's centre, as bright as the star shows in the frame there, so a rock
   or a world in front of it dims them. From every bright spot (as a pseudo lens flare) the laser's
   hot spot made them too, and a bright limb or sky swept arcs across the view.
3. **FTL zoom blur:** in FTL, 12 samples toward the point you're heading for (away from it when it's
   behind you), stronger toward the edges and with speed (from ~1,000 to ~1,000,000 km/s), kept to a
   tenth of full strength: a hint of speed, not a smear.
4. The volumetric clouds laid over, then the tone map (linear to 0.8, a soft shoulder toward 1).

The HUD and the overlay are drawn separately, so they stay sharp.

**Dev note:** after editing shaders or constants, reload with a fresh URL (`?r=n`) or restart the dev
server: a page that has taken hot updates can keep serving old module versions.
