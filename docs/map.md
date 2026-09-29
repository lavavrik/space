# System map (Shift+O)

`render/SystemMap.ts`. The whole system in one zoomable 3D view, drawn on the HUD canvas over a
darkened screen; the flight HUD steps aside (only the messages stay). The game keeps running.

- **What's on it:** the star; every world the radar knows, with its orbit round its parent (moons
  once their orbit is a few pixels across), and rings; stations, with their orbits (sky stations
  just marked); other ships the radar knows; your ship (a cyan arrowhead along your motion) and its
  orbit round the world whose sphere of influence you're in (the whole ellipse if bound, the escape
  arc out to the sphere of influence if not); the autopilot's target orbit (dashed); your target
  (red brackets) and a dotted line to it.
- **Moving round:** drag to turn the view round its focus, the wheel to zoom (10 km to ~1,000 AU),
  click something to target it and make it the view's centre (the view eases across; the zoom stays). It opens
  centred on your ship, framing the world you're near.
- **Precision:** everything is projected on the CPU in double precision, relative to the camera,
  so the view holds at any scale (a GPU scene at these distances would need its own rebasing).
- **Orbits at every zoom:** each is sampled finely where it passes the view's centre (steps from
  1/200 of the view there, growing ×1.25 up to 2° on the far side), and lines are clipped at a near
  plane rather than dropped. A fixed 160-point ellipse missed its own world by tens of thousands of
  km zoomed in (the chords' sag), so orbits seemed to vanish at some zooms.
- **Depth:** world discs are drawn first, then the orbits over them; a point of a line that falls
  on a disc and lies deeper than the world's centre is skipped (pen lifted), so an orbit passes in
  front of its world and hides behind it.
- **Labels** respect Shift+N; where they'd overlap, the first placed wins (the star and planets are
  drawn first). A scale bar (bottom right) gives a round length at the focus's distance.

Not yet: the navigation computer's multi-system route (that's the galaxy map), time controls on the
map, plotting manoeuvres on it.
