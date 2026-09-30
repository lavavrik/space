# Post-processing

After the scene (and the volumetric clouds, docs/clouds.md), in `gpu/post.ts`, `bloom.wgsl` and
the final pass `tonemap.wgsl`:

1. **Bloom:** light over 2 (display units: the star's disc and glow, signal lights, the laser,
   sparks and plasma; not a lit planet or a daylit sky) is kept by the first downsample (soft
   knee; each tap group weighted down by its brightness so single hot pixels don't flicker), then
   blurred wide through 6 half-size copies (13-tap down, tent up, added back up the chain; after
   Jimenez's Call of Duty: AW talk). The largest is added to the frame at 0.25.
2. **Lens flare, from the star only:** four small tinted ghosts along the line from the star through
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
