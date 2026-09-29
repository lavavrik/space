/*
 * The system map (Shift+O; docs/map.md): the whole system in one zoomable 3D view, drawn on the HUD
 * canvas over a darkened screen. Worlds and their orbits, moons, rings, stations (orbits for the
 * orbital ones), other ships the radar knows, your ship with its orbit round the world you're in the
 * sphere of influence of, the autopilot's target orbit, your target, and the navigation computer's
 * destination.
 *
 * The camera circles a focus (your ship to begin with) at a distance: drag to turn it round, the wheel
 * to zoom (10 km to ~1,000 AU), click something to target it and centre on it. It's all projected
 * here (double precision, positions relative to the focus), so nothing loses precision at any scale.
 */
import type { Game } from '../Game';
import { fmtDist } from '../format';
import { THREE } from '../lib/three';
import { known } from '../sim/radar';
import type { Body, Target, World } from '../types';

const AMB = 'rgba(255,176,64,',
  MINT = 'rgba(115,255,178,',
  CYA = 'rgba(127,220,255,',
  RED = 'rgba(255,91,70,';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const FOV = 50;
/** Samples round a closed orbit. */
const ORBIT_N = 160;

/** What the map is doing (Game.map). */
export interface MapState {
  open: boolean;
  focus: Target | 'ship';
  dist: number; // m, camera to focus
  yaw: number;
  pitch: number;
  /** The focus point the view eases toward when the focus changes (world, m). */
  from: THREE.Vector3 | null;
  ease: number; // 0…1 through the move
}

export const mapClosed = (): MapState => ({ open: false, focus: 'ship', dist: 1e8, yaw: 0.6, pitch: 0.5, from: null, ease: 1 });

interface Pick {
  x: number;
  y: number;
  t: Target | 'ship';
}

const V = () => new THREE.Vector3();

export class SystemMap {
  private picks: Pick[] = [];
  // camera (world, m) and its axes
  private readonly cam = V();
  private readonly fwd = V();
  private readonly right = V();
  private readonly up = V();
  private f = 1;
  private cx = 0;
  private cy = 0;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly ui: () => number,
  ) {}

  /** Open (focused on your ship, framing the world you're near) or close. */
  toggle(g: Game) {
    const m = g.map;
    m.open = !m.open;
    if (!m.open) return;
    document.exitPointerLock?.();
    m.focus = 'ship';
    m.from = null;
    m.ease = 1;
    const b = g.frameBody;
    const d = g.ship.pos.distanceTo(b.pos);
    m.dist = Math.max(b.radius * 8, d * 3, 2e7);
  }

  /** The focus's position now (world). */
  private focusPos(g: Game, t: Target | 'ship') {
    return t === 'ship' ? g.ship.pos.clone() : t.pos.clone();
  }

  /** Drag: turn the view round the focus. */
  rotate(g: Game, dx: number, dy: number) {
    const m = g.map;
    m.yaw -= dx * 0.005;
    m.pitch = Math.max(-1.5, Math.min(1.5, m.pitch + dy * 0.005));
  }

  /** Wheel: zoom (10 km … ~1,000 AU). */
  zoom(g: Game, deltaY: number) {
    const m = g.map;
    m.dist = Math.max(1e4, Math.min(1.5e14, m.dist * Math.pow(1.0015, deltaY)));
  }

  /** Click: target what's under the cursor and centre on it. Returns whether it hit something. */
  click(g: Game, x: number, y: number) {
    let best: Pick | null = null,
      bestD = 14 * this.ui();
    for (const p of this.picks) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return false;
    const m = g.map;
    const cur = this.focusPos(g, m.focus);
    m.from = cur;
    m.ease = 0;
    m.focus = best.t;
    if (best.t !== 'ship') {
      g.target = best.t;
      g.showMsg(`Target · ${best.t.name}`);
      // frame what was picked: a world a few radii across, a station or ship a few km
      const size = best.t.kind === 'station' ? 5e3 : best.t.kind === 'ship' ? 2e3 : best.t.radius * 6;
      if (m.dist > size * 50 || m.dist < size) m.dist = Math.max(size, 1e4);
    }
    return true;
  }

  private project(p: THREE.Vector3, out: { x: number; y: number; z: number }) {
    const vx = p.x - this.cam.x,
      vy = p.y - this.cam.y,
      vz = p.z - this.cam.z;
    const z = vx * this.fwd.x + vy * this.fwd.y + vz * this.fwd.z;
    out.z = z;
    if (z <= 0) return false;
    out.x = this.cx + ((vx * this.right.x + vy * this.right.y + vz * this.right.z) / z) * this.f;
    out.y = this.cy - ((vx * this.up.x + vy * this.up.y + vz * this.up.z) / z) * this.f;
    return true;
  }

  /** A polyline through world points (skipping stretches behind the camera). */
  private path(pts: THREE.Vector3[], stroke: string, width = 1, dash: number[] = []) {
    const { ctx } = this;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width * this.ui();
    ctx.setLineDash(dash.map((d) => d * this.ui()));
    ctx.beginPath();
    const s = { x: 0, y: 0, z: 0 };
    let pen = false;
    for (const p of pts) {
      if (!this.project(p, s)) {
        pen = false;
        continue;
      }
      if (pen) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
      pen = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** How many pixels a length L at world point p spans on screen (0 behind the camera). */
  private px(p: THREE.Vector3, L: number) {
    const s = { x: 0, y: 0, z: 0 };
    return this.project(p, s) ? (L / s.z) * this.f : 0;
  }

  draw(g: Game, W: number, H: number) {
    const { ctx } = this;
    const m = g.map;
    const ui = this.ui();
    this.picks = [];
    // the focus, easing from the last one
    const fp = this.focusPos(g, m.focus);
    if (m.from && m.ease < 1) {
      m.ease = Math.min(1, m.ease + 0.04);
      const k = m.ease * m.ease * (3 - 2 * m.ease);
      fp.lerpVectors(m.from, fp, k);
    }
    // camera round the focus: yaw about the system's up (+y), pitch above its plane
    const cp = Math.cos(m.pitch);
    this.cam.set(Math.sin(m.yaw) * cp, Math.sin(m.pitch), Math.cos(m.yaw) * cp).multiplyScalar(m.dist).add(fp);
    this.fwd.subVectors(fp, this.cam).normalize();
    this.right.crossVectors(this.fwd, new THREE.Vector3(0, 1, 0)).normalize();
    this.up.crossVectors(this.right, this.fwd);
    this.cx = W / 2;
    this.cy = H / 2;
    this.f = H / 2 / Math.tan((FOV * Math.PI) / 360);

    ctx.save();
    ctx.fillStyle = 'rgba(2,4,8,0.9)';
    ctx.fillRect(0, 0, W, H);
    const s = { x: 0, y: 0, z: 0 };
    const { cur } = g;

    // orbits: every world round its parent (moons only once their orbit is a few pixels across)
    for (const b of cur.bodies) {
      if (b.kind === 'star' || !known(g, b)) continue;
      const span = this.px(b.parent.pos, b.orb.a);
      if (span < 4) continue;
      const a = b.kind === 'moon' ? 0.28 : 0.4;
      this.path(ellipse(b.parent.pos, b.orb.a, b.orb.e, b.orb.P, b.orb.Q), AMB + a + ')', b === g.target ? 1.6 : 1);
      // rings
      if (b.ring && this.px(b.pos, b.radius * b.ring.outer) > 3) {
        for (const r of [b.ring.inner, b.ring.outer]) this.path(circle(b.pos, b.radius * r, b.axis), 'rgba(210,190,150,0.35)');
      }
    }
    // station orbits
    for (const st of cur.stations) {
      if (st.sky || !known(g, st) || this.px(st.parent.pos, st.a) < 6) continue;
      this.path(ellipse(st.parent.pos, st.a, st.e, st.P, st.Q), MINT + (st === g.target ? '0.7)' : '0.3)'));
    }
    // your orbit round the world you're in the sphere of influence of
    const fb = g.frameBody;
    const mine = shipOrbit(g.ship.pos.clone().sub(fb.pos), g.ship.vel.clone(), fb.mu, fb.kind === 'star' ? Infinity : fb.soi, fb);
    if (mine) this.path(mine, CYA + '0.85)', 1.4);
    // the autopilot's target orbit (dashed)
    const ap = g.ship.ap;
    if (ap && ap.n && ap.type !== 'hold' && ap.type !== 'rendezvous') this.path(circle(ap.body.pos, ap.r0, ap.n), CYA + '0.6)', 1.2, [6, 5]);
    // a line to the target and to the navigation computer's destination
    if (g.target && g.target.pos) this.path([g.ship.pos, g.target.pos], RED + '0.35)', 1, [3, 6]);

    // bodies
    ctx.font = `${11 * ui}px ${MONO}`;
    ctx.textAlign = 'left';
    // labels: first come, first placed; one that would overlap a placed one is left out (the star
    // and planets are drawn first, so crowded moons and stations give way to them)
    const placed: [number, number, number, number][] = [];
    const label = (x: number, y: number, t: string, col: string) => {
      if (!g.showNames) return;
      const lx = x + 7 * ui,
        ly = y - 6 * ui,
        w = ctx.measureText(t).width,
        h = 12 * ui;
      if (placed.some(([ax, ay, aw, ah]) => lx < ax + aw && lx + w > ax && ly - h < ay && ly > ay - ah)) return;
      placed.push([lx, ly, w, h]);
      ctx.fillStyle = col;
      ctx.fillText(t, lx, ly);
    };
    for (const b of cur.bodies) {
      if (!known(g, b) && b.kind !== 'star') continue;
      if (!this.project(b.pos, s)) continue;
      if (b.kind === 'moon' && this.px(b.parent.pos, b.orb.a) < 12 && b !== g.target) continue;
      const r = Math.max(b.kind === 'star' ? 5 : 2.5, (b.radius / s.z) * this.f);
      ctx.fillStyle = bodyColor(b);
      ctx.beginPath();
      ctx.arc(s.x, s.y, Math.min(r, H), 0, Math.PI * 2);
      ctx.fill();
      this.picks.push({ x: s.x, y: s.y, t: b });
      label(s.x + Math.min(r, 40) - 4 * ui, s.y, b.name, b.kind === 'star' ? 'rgba(255,240,200,0.9)' : AMB + (b.kind === 'moon' ? '0.6)' : '0.85)'));
    }
    for (const st of cur.stations) {
      if (!known(g, st) || !this.project(st.pos, s)) continue;
      if (this.px(st.parent.pos, st.parent.radius) < 6 && st !== g.target) continue;
      const k = 4 * ui;
      ctx.strokeStyle = MINT + '0.9)';
      ctx.lineWidth = 1.2 * ui;
      ctx.strokeRect(s.x - k, s.y - k, 2 * k, 2 * k);
      this.picks.push({ x: s.x, y: s.y, t: st });
      label(s.x, s.y, st.name, MINT + '0.8)');
    }
    for (const npc of g.traffic) {
      if (!known(g, npc) || !this.project(npc.pos, s)) continue;
      ctx.fillStyle = 'rgba(255,230,199,0.6)';
      ctx.fillRect(s.x - 1.5 * ui, s.y - 1.5 * ui, 3 * ui, 3 * ui);
      this.picks.push({ x: s.x, y: s.y, t: npc });
    }
    // the target: brackets
    if (g.target && this.project(g.target.pos, s)) {
      const k = 9 * ui,
        t = 4 * ui;
      ctx.strokeStyle = RED + '0.9)';
      ctx.lineWidth = 1.4 * ui;
      ctx.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        ctx.moveTo(s.x + sx * k, s.y + sy * (k - t));
        ctx.lineTo(s.x + sx * k, s.y + sy * k);
        ctx.lineTo(s.x + sx * (k - t), s.y + sy * k);
      }
      ctx.stroke();
    }
    // you: a cyan arrowhead along your velocity through your frame
    if (this.project(g.ship.pos, s)) {
      const ahead = g.ship.pos.clone().addScaledVector(g.ship.vel.lengthSq() > 1 ? g.ship.vel.clone().normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(g.ship.q), m.dist * 0.02);
      const a = { x: 0, y: 0, z: 0 };
      let ang = -Math.PI / 2;
      if (this.project(ahead, a)) ang = Math.atan2(a.y - s.y, a.x - s.x);
      const k = 7 * ui;
      ctx.fillStyle = CYA + '1)';
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(ang) * k, s.y + Math.sin(ang) * k);
      ctx.lineTo(s.x + Math.cos(ang + 2.5) * k, s.y + Math.sin(ang + 2.5) * k);
      ctx.lineTo(s.x + Math.cos(ang - 2.5) * k, s.y + Math.sin(ang - 2.5) * k);
      ctx.closePath();
      ctx.fill();
      this.picks.push({ x: s.x, y: s.y, t: 'ship' });
      label(s.x, s.y, 'YOU', CYA + '0.95)');
    }

    // title, scale and hints
    const focusName = m.focus === 'ship' ? 'your ship' : m.focus.name;
    ctx.fillStyle = AMB + '0.95)';
    ctx.font = `${13 * ui}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.fillText(`SYSTEM MAP · ${g.cur.sys.name.toUpperCase()} · CENTRED ON ${focusName.toUpperCase()}`, W / 2, 26 * ui);
    ctx.font = `${11 * ui}px ${MONO}`;
    ctx.fillStyle = AMB + '0.6)';
    ctx.fillText(`view ${fmtDist(m.dist)} out · drag to turn · wheel to zoom · click to target and centre · Shift+O closes`, W / 2, 44 * ui);
    // a scale bar: the biggest round length under 160 px
    const mPerPx = m.dist / this.f;
    const nice = niceLength(mPerPx * 160 * ui);
    const w = nice / mPerPx;
    ctx.strokeStyle = AMB + '0.7)';
    ctx.lineWidth = 1.2 * ui;
    ctx.beginPath();
    // (bottom right: the messages sit bottom centre)
    ctx.moveTo(W - 24 * ui - w, H - 30 * ui);
    ctx.lineTo(W - 24 * ui, H - 30 * ui);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillStyle = AMB + '0.7)';
    ctx.fillText(`${fmtDist(nice)} at the focus`, W - 24 * ui, H - 38 * ui);
    ctx.restore();
  }
}

/** A closed Kepler orbit round `c`: periapsis along P, 90° ahead along Q. */
function ellipse(c: THREE.Vector3, a: number, e: number, P: THREE.Vector3, Q: THREE.Vector3) {
  const pts: THREE.Vector3[] = [];
  const b = a * Math.sqrt(Math.max(0, 1 - e * e));
  for (let i = 0; i <= ORBIT_N; i++) {
    const E = (i / ORBIT_N) * Math.PI * 2;
    pts.push(c.clone().addScaledVector(P, a * (Math.cos(E) - e)).addScaledVector(Q, b * Math.sin(E)));
  }
  return pts;
}

/** A circle of radius r round `c` in the plane with normal n. */
function circle(c: THREE.Vector3, r: number, n: THREE.Vector3) {
  const u = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  return ellipse(c, r, 0, u, v);
}

/**
 * The ship's conic round its frame body, from its position and velocity relative to it: the whole
 * ellipse if bound, else the escape arc out to the sphere of influence. Null if it's barely moving
 * against the body (a degenerate straight fall).
 */
function shipOrbit(r: THREE.Vector3, v: THREE.Vector3, mu: number, soi: number, b: Body) {
  const h = new THREE.Vector3().crossVectors(r, v);
  if (h.length() < 1e-6) return null;
  const rl = r.length();
  const ev = new THREE.Vector3().crossVectors(v, h).divideScalar(mu).addScaledVector(r, -1 / rl);
  const e = ev.length();
  const p = h.lengthSq() / mu; // semi-latus rectum
  const P = e > 1e-9 ? ev.clone().divideScalar(e) : r.clone().normalize();
  const Q = new THREE.Vector3().crossVectors(h, P).normalize();
  const pts: THREE.Vector3[] = [];
  // true anomaly range: all round if bound, else as far as the SOI (or the asymptote)
  let nuMax = Math.PI;
  if (e >= 1) {
    nuMax = Math.acos(Math.max(-1, Math.min(1, -1 / e))) - 1e-3;
    const rMax = Number.isFinite(soi) ? soi : rl * 20;
    // the anomaly where r reaches rMax: p / (1 + e cos ν) = rMax
    const c = (p / rMax - 1) / e;
    if (c > -1 && c < 1) nuMax = Math.min(nuMax, Math.acos(c));
  }
  for (let i = 0; i <= ORBIT_N * 2; i++) {
    const nu = -nuMax + (2 * nuMax * i) / (ORBIT_N * 2);
    const rr = p / (1 + e * Math.cos(nu));
    if (rr <= 0 || rr > (Number.isFinite(soi) ? soi * 1.01 : Infinity)) continue;
    pts.push(b.pos.clone().addScaledVector(P, rr * Math.cos(nu)).addScaledVector(Q, rr * Math.sin(nu)));
  }
  return pts;
}

function bodyColor(b: Body) {
  if (b.kind === 'star') return `rgb(${Math.round(b.color.r * 255)},${Math.round(b.color.g * 255)},${Math.round(b.color.b * 255)})`;
  const c = (b as World).pal.a.clone().lerp((b as World).pal.b, 0.5);
  return `rgb(${Math.round(Math.min(1, c.r * 1.4) * 255)},${Math.round(Math.min(1, c.g * 1.4) * 255)},${Math.round(Math.min(1, c.b * 1.4) * 255)})`;
}

/** 1, 2 or 5 × a power of ten, at most x. */
function niceLength(x: number) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

