# The FTL leg's course

The autopilot's FTL leg (an orbit, a rendezvous, a Lagrange hold, a nav route's last leg, other ships' errands) flies a planned course round the gravity wells, not the straight line (`sim/ftlPath.ts`, flown by `sim/autopilot.ts ftlTransfer`).

## Why a course

Near a body the drive is held to 0.9 × the altitude ÷ its well factor (`sim/ftl.ts ftlSpeedLimit`), so FTL speed falls in proportion to the distance from it. In a field like this the fastest way round a body is a **logarithmic spiral**: in (ln r, θ) about the body the travel time is plain distance, so the quickest path is a straight line there. A giant on the way slows the drive for ~0.3 AU either side of it.

The straight leg went round a world only when the line would cut its drop-out altitude, chasing a point 5° ahead at its own distance. The closing slowdown (0.8 × the distance) then applied to that near point, so it crept round. Anything the line merely passed close to (a giant's well, the world just left) it flew straight through, at the speed there. Between two worlds 1 AU out on opposite sides of a Sun-like star, the planned arc takes 60 s, the old leg 133 s, and skimming the star ~9 minutes.

## Planning

- **Cost:** a course's time is ∫ ds / v through the speed field the leg really flies in: the slowest of every body's well, the drive's top speed (2,000 c), and the slowdown closing on the drop point (0.8 × the distance, cut off where the leg drops out). Each segment is integrated by adaptive Simpson's rule. A segment from low over a world out into the open has nearly all its time in its first few percent, and five fixed samples missed it, so the search skimmed worlds it thought were quick to pass.
- **Walls:** every body's sphere at 1.1× its drop-out altitude (never reaching the drop point itself) costs 10⁵ s × how deep a segment cuts into it, so the course keeps clear of worlds. The drive's emergency drop-out still backs it up.
- **Candidates:** the straight line, and a spiral round each star and planet (moons sit inside their planets' wells). The quickest is kept.
- **Refining:** 12 segments, re-spaced at equal shares of the time (thick in a well, thin in the open), then a pattern search: each inner point tries a step along the course and either way across it, keeps a move that saves time (growing its step), else halves it.

## Flying

- The ship's end of the course follows the ship, the far end the drop point. The inner points are carried with the destination, as the ship is (the leg flies in its frame), and dropped once the ship is nearer the point after them.
- Twice a second the course is refined again, from small steps, so it follows the worlds as they move. It's re-spaced only once half its points are behind: each re-spacing cuts its corners a little, and doing it every time swung the course about and once into the world being left.
- The nose turns onto a point 1.5 s ahead along the course. The speed is what it was before: the well limit where the ship is, 0.8 × the distance to the drop point, scaled down by alignment^8.
- The leg drops out within max(30 km, 1 % of the drop radius) of the drop point. The course is planned afresh each time the drive engages and isn't saved (a loaded game plans it again).
- The maneuver guide's ETA for the FTL transfer is the course's own time. The system map (Shift+O) draws it, dotted cyan, while it's flown.

## Cost

Planning takes 1.5–5 ms once per leg (40 bodies at worst, among the systems within 25 ly of home), and keeping the course up ~0.03 ms a frame.

## Results

Fly-throughs in `__tests__/ftlPath.test.ts`. Over 126 legs between worlds in the 40 systems nearest home, each took 0.47–1.00× the time of the old straight leg (median 0.77), 25 % less in all, and none came within a world's drop-out altitude.

## Travel to the target (Shift+G)

One key for the autopilot to take you to whatever is targeted, with the plan the orbit planner would open with: a station gets a rendezvous beside it (K docks from there), a Lagrange point a hold at it, a world or star its default orbit (the planner's first type at its default altitude). It charges the FTL drive and flies the leg when that's quicker, climbing out of a mass lock first; short hops go on thrusters. It won't chase a ship or a wreck, and not while docked, during a hyperjump charge or while a nav route is flying. O shows its status, and Backspace ×2 disengages it, as for any autopilot flight.
