/*
 * The autopilot's FTL course (docs/ftlpath.md): a path to the drop point that keeps clear of the
 * gravity wells which slow the drive, instead of the straight line.
 *
 * Near a body the drive is held to 0.9 × the altitude ÷ its well factor (sim/ftl.ts ftlSpeedLimit),
 * so FTL speed falls in proportion to the distance from it. In such a field the fastest way round a
 * body is a logarithmic spiral: in (ln r, θ) about it the travel time is plain distance, so the best
 * path is a straight line there. Two worlds 1 AU out on opposite sides of a Sun-like star are ~1
 * minute apart on the arc round it and ~9 skimming the star at its drop-out altitude, where the
 * drive crawls. A giant on the way slows you for ~0.3 AU either side of it.
 *
 * Planning: a few candidate courses (the straight line, and a spiral round each star and planet),
 * each costed as the drive would fly it (the time ∫ ds / v through every body's well, the drive's
 * top speed and the slowdown closing on the drop point), the quickest kept, then refined by moving
 * its points one at a time while that saves time (a pattern search). Every body's drop-out sphere is
 * a wall (a penalty), so the course can't run into a world either.
 *
 * Flying: the course is refined twice a second as the ship goes and the worlds move, its points
 * carried with the destination as the ship is (the leg flies in its frame: sim/autopilot.ts
 * ftlTransfer), dropped as they're passed and re-spaced once half are gone, and steered by a point
 * a little way along it.
 */
import { FTL_MAX } from '../constants';
import { THREE } from '../lib/three';
import type { Autopilot, Body } from '../types';
import { dropAlt, wellFactor } from './ftl';

/** A course to the drop point: its points, the ship first and the drop point last (system frame). */
export interface FtlPath {
  pts: THREE.Vector3[];
  /** Each inner point's search step (m), set afresh before each refining. */
  step: number[];
  /** Seconds to the next re-spacing and refining. */
  next: number;
}

/** Segments in a course. */
const SEGS = 12;
/** How often (s) the course is re-spaced and refined, and how many refining sweeps then. */
const REFINE_S = 0.5;
const SWEEPS = 4;
/** Refining sweeps when a course is first planned. */
const PLAN_SWEEPS = 12;
/** The course steers by a point this far ahead (s at the current speed). */
const LOOK_S = 1.5;
/** A course keeps out of each body's drop-out sphere, padded by this (× the drop altitude). */
const CLEAR_K = 1.1;
/** The cost (s) of running right through a body's sphere: a wall, scaled by how deep. */
const WALL_S = 1e5;
/** ftlSpeedLimit's floor and well slope, and ftlTransfer's closing rate (1/s). */
const V_FLOOR = 2e4,
  WELL_K = 0.9,
  CLOSE_K = 0.8;

/** The wells a course is costed against: each body's centre, its drop sphere and its well factor. */
interface Well {
  x: number;
  y: number;
  z: number;
  r: number;
  clear: number;
  wf: number;
}

/** What a course is costed against: the wells, the drop point and the distance the leg drops out at. */
export interface Field {
  wells: Well[];
  P: THREE.Vector3;
  drop: number;
}

export function fieldOf(bodies: Body[], P: THREE.Vector3, drop: number): Field {
  // (a wall never reaches the drop point: the leg to a low orbit drops out just over the drop-out altitude)
  const wells = bodies.map((b) => ({ x: b.pos.x, y: b.pos.y, z: b.pos.z, r: b.radius, clear: Math.min(b.radius + dropAlt(b) * CLEAR_K, 0.999 * b.pos.distanceTo(P)), wf: wellFactor(b) }));
  return { wells, P, drop };
}

/** Seconds per metre the drive takes at (x, y, z): the slowest of every well, its top speed and the closing on the drop point. */
function pace(f: Field, x: number, y: number, z: number) {
  let v = FTL_MAX;
  for (const w of f.wells) {
    const dx = x - w.x,
      dy = y - w.y,
      dz = z - w.z;
    const alt = Math.max(0, Math.sqrt(dx * dx + dy * dy + dz * dz) - w.r);
    v = Math.min(v, (WELL_K * alt) / w.wf);
  }
  v = Math.max(v, V_FLOOR);
  const dx = x - f.P.x,
    dy = y - f.P.y,
    dz = z - f.P.z;
  // (the closing slowdown is cut off at the drop distance: inside it the leg is over)
  v = Math.min(v, CLOSE_K * Math.max(f.drop, Math.sqrt(dx * dx + dy * dy + dz * dz)));
  return 1 / v;
}

/**
 * ∫ pace over t ∈ [t0, t1] along a + e t, by adaptive Simpson's rule: halves where the halves
 * disagree. A segment from low over a world out into the open has its pace falling a thousandfold,
 * nearly all of the time in its first few percent; five fixed points missed that, and the search
 * skimmed worlds it thought were quick to pass.
 */
function simpson(f: Field, a: THREE.Vector3, e: THREE.Vector3, t0: number, t1: number, p0: number, pm: number, p1: number, whole: number, depth: number): number {
  const tm = (t0 + t1) / 2,
    h = t1 - t0;
  const tl = (t0 + tm) / 2,
    tr = (tm + t1) / 2;
  const pl = pace(f, a.x + e.x * tl, a.y + e.y * tl, a.z + e.z * tl),
    pr = pace(f, a.x + e.x * tr, a.y + e.y * tr, a.z + e.z * tr);
  const left = (h / 12) * (p0 + 4 * pl + pm),
    right = (h / 12) * (pm + 4 * pr + p1);
  if (depth <= 0 || Math.abs(left + right - whole) < SIMPSON_TOL * (left + right)) return left + right + (left + right - whole) / 15;
  return simpson(f, a, e, t0, tm, p0, pl, pm, left, depth - 1) + simpson(f, a, e, tm, t1, pm, pr, p1, right, depth - 1);
}
/** Adaptive Simpson's relative tolerance, and how many times it may halve. */
const SIMPSON_TOL = 0.01,
  SIMPSON_DEPTH = 12;
const tmpE = new THREE.Vector3();

/**
 * The time (s) to fly from a to b, plus (unless `walls` is false) the wall of any sphere it cuts.
 */
export function segCost(f: Field, a: THREE.Vector3, b: THREE.Vector3, walls = true) {
  const e = tmpE.subVectors(b, a);
  const ex = e.x,
    ey = e.y,
    ez = e.z;
  const L2 = ex * ex + ey * ey + ez * ez,
    L = Math.sqrt(L2);
  if (L === 0) return 0;
  const p0 = pace(f, a.x, a.y, a.z),
    pm = pace(f, a.x + ex / 2, a.y + ey / 2, a.z + ez / 2),
    p1 = pace(f, b.x, b.y, b.z);
  let cost = L * simpson(f, a, e, 0, 1, p0, pm, p1, (p0 + 4 * pm + p1) / 6, SIMPSON_DEPTH);
  if (!walls) return cost;
  for (const w of f.wells) {
    // the segment's closest approach to the centre
    const t = Math.max(0, Math.min(1, ((w.x - a.x) * ex + (w.y - a.y) * ey + (w.z - a.z) * ez) / L2));
    const dx = a.x + ex * t - w.x,
      dy = a.y + ey * t - w.y,
      dz = a.z + ez * t - w.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < w.clear) cost += WALL_S * (1 - d / w.clear);
  }
  return cost;
}

/** The time (s) to fly a whole course. */
export function pathCost(f: Field, pts: THREE.Vector3[]) {
  let c = 0;
  for (let i = 0; i + 1 < pts.length; i++) c += segCost(f, pts[i], pts[i + 1]);
  return c;
}

/** The straight line from a to b. */
function straight(a: THREE.Vector3, b: THREE.Vector3) {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= SEGS; i++) pts.push(a.clone().lerp(b, i / SEGS));
  return pts;
}

/**
 * The logarithmic spiral from a to b round centre c: sweeping the angle between them evenly, the
 * distance from c going geometrically from a's to b's. Each step takes about the same time while
 * c's well holds the drive back. Null if a or b is at the centre.
 */
function spiral(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const ua = a.clone().sub(c),
    ub = b.clone().sub(c);
  const ra = ua.length(),
    rb = ub.length();
  if (ra === 0 || rb === 0) return null;
  ua.divideScalar(ra);
  ub.divideScalar(rb);
  const th = ua.angleTo(ub);
  const axis = new THREE.Vector3().crossVectors(ua, ub);
  if (axis.lengthSq() < 1e-12) {
    // straight through the centre (or straight away): any way round, so perpendicular to the line
    axis.set(0, 1, 0).cross(ua);
    if (axis.lengthSq() < 1e-12) axis.set(1, 0, 0).cross(ua);
  }
  axis.normalize();
  const pts: THREE.Vector3[] = [a.clone()];
  for (let i = 1; i < SEGS; i++) {
    const s = i / SEGS;
    pts.push(c.clone().addScaledVector(ua.clone().applyAxisAngle(axis, th * s), ra * Math.pow(rb / ra, s)));
  }
  pts.push(b.clone());
  return pts;
}

/**
 * Re-space a course's points at equal shares of its time (the ship first, the drop point last),
 * so the search has its points where the time goes: thick in a well, thin out in the open. (The
 * time flown only: with the walls' cost in it, every point went into a segment cutting one.)
 */
function respace(f: Field, pts: THREE.Vector3[]) {
  const c = [0];
  for (let i = 0; i + 1 < pts.length; i++) c.push(c[i] + segCost(f, pts[i], pts[i + 1], false));
  const T = c[c.length - 1];
  if (!(T > 0)) return pts;
  const out = [pts[0].clone()];
  let j = 0;
  for (let k = 1; k < SEGS; k++) {
    const t = (T * k) / SEGS;
    while (j < pts.length - 2 && c[j + 1] < t) j++;
    const u = c[j + 1] > c[j] ? (t - c[j]) / (c[j + 1] - c[j]) : 0;
    out.push(pts[j].clone().lerp(pts[j + 1], Math.min(1, Math.max(0, u))));
  }
  out.push(pts[pts.length - 1].clone());
  return out;
}

const tmpT = new THREE.Vector3(),
  tmpN1 = new THREE.Vector3(),
  tmpN2 = new THREE.Vector3(),
  tmpP = new THREE.Vector3();

/**
 * Refine a course: move each inner point a step along the course or either way across it, keeping a
 * move that saves time (and growing that point's step), else halving its step.
 */
function refine(f: Field, path: FtlPath, sweeps: number) {
  const { pts, step } = path;
  for (let s = 0; s < sweeps; s++) {
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1],
        p = pts[i],
        b = pts[i + 1];
      tmpT.subVectors(b, a);
      if (tmpT.lengthSq() === 0) continue;
      tmpT.normalize();
      tmpN1.set(1, 0, 0);
      if (Math.abs(tmpT.x) > 0.9) tmpN1.set(0, 1, 0);
      tmpN1.cross(tmpT).normalize();
      tmpN2.crossVectors(tmpT, tmpN1);
      const base = segCost(f, a, p) + segCost(f, p, b);
      let moved = false;
      for (const dir of [tmpN1, tmpN2, tmpT]) {
        for (const sgn of [1, -1]) {
          tmpP.copy(p).addScaledVector(dir, sgn * step[i]);
          if (segCost(f, a, tmpP) + segCost(f, tmpP, b) < base) {
            p.copy(tmpP);
            moved = true;
            break;
          }
        }
        if (moved) break;
      }
      step[i] = moved ? step[i] * 1.5 : step[i] * 0.5;
    }
  }
}

/** Fresh search steps: a share `k` of the span between each point's neighbours. */
function steps(pts: THREE.Vector3[], k: number) {
  return pts.map((_, i) => (i === 0 || i === pts.length - 1 ? 0 : k * pts[i - 1].distanceTo(pts[i + 1])));
}
/** The share of a point's span its search starts with: planning a course, and keeping it up to date. */
const STEP_PLAN = 0.1,
  STEP_KEEP = 0.02;

/**
 * Plan a course from `from` to the drop point: the quickest of the straight line and a spiral round
 * each star and planet, re-spaced and refined.
 */
export function planPath(bodies: Body[], from: THREE.Vector3, f: Field): FtlPath {
  let best = straight(from, f.P),
    bestC = pathCost(f, best);
  for (const b of bodies) {
    if (b.kind === 'moon') continue; // (a moon's well sits inside its planet's)
    const sp = spiral(from, f.P, b.pos);
    if (!sp) continue;
    const c = pathCost(f, sp);
    if (c < bestC) {
      best = sp;
      bestC = c;
    }
  }
  const pts = respace(f, best);
  const path: FtlPath = { pts, step: steps(pts, STEP_PLAN), next: REFINE_S };
  refine(f, path, PLAN_SWEEPS);
  path.pts = respace(f, path.pts);
  path.step = steps(path.pts, STEP_KEEP);
  refine(f, path, SWEEPS);
  return path;
}

/**
 * This frame's point to steer for on the autopilot's FTL course, planning it first if need be: the
 * ship's end of the course is moved to the ship, the far end to the drop point, the rest carried
 * by `carry` (the destination's motion this frame). Points the ship has passed are dropped, and
 * twice a second the course is refined (and re-spaced, once half its points are behind).
 */
export function steerPath(ap: Autopilot, bodies: Body[], ship: { pos: THREE.Vector3; ftlSpeed: number }, P: THREE.Vector3, drop: number, carry: THREE.Vector3, dt: number) {
  const f = fieldOf(bodies, P, drop);
  if (!ap.path) ap.path = planPath(bodies, ship.pos, f);
  const path = ap.path,
    pts = path.pts;
  for (let i = 1; i < pts.length - 1; i++) pts[i].add(carry);
  pts[0].copy(ship.pos);
  pts[pts.length - 1].copy(P);
  // passed the next point (nearer the one after it than it is): drop it
  while (pts.length > 2 && ship.pos.distanceTo(pts[2]) < pts[1].distanceTo(pts[2])) pts.splice(1, 1);
  path.next -= dt;
  if (path.next <= 0) {
    path.next = REFINE_S;
    // (re-spaced only once half its points are behind: each re-spacing cuts its corners a little,
    // and done every time it swung the course about, and once into the world being left)
    if (pts.length - 1 < SEGS / 2) path.pts = respace(f, pts);
    path.step = steps(path.pts, STEP_KEEP);
    refine(f, path, SWEEPS);
  }
  return along(path.pts, Math.max(1, ship.ftlSpeed * LOOK_S));
}

/** The point `d` metres along a course from its start (its end if it's shorter). */
function along(pts: THREE.Vector3[], d: number) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const L = pts[i].distanceTo(pts[i + 1]);
    if (d <= L) return pts[i].clone().lerp(pts[i + 1], L > 0 ? d / L : 1);
    d -= L;
  }
  return pts[pts.length - 1].clone();
}

/** Seconds still to fly on the autopilot's FTL course (null before it's planned). */
export function pathEta(ap: Autopilot, bodies: Body[], P: THREE.Vector3, drop: number) {
  if (!ap.path) return null;
  return pathCost(fieldOf(bodies, P, drop), ap.path.pts);
}
