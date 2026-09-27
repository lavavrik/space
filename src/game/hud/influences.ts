/*
 * Influences panel (B): what's acting on the ship right now, as a built-in instrument.
 *   Gravity  every body's pull (the physics applies only the dominant one: patched conics)
 *   Frame    whose sphere of influence you're in, its edge, the next one you'd enter, and what
 *            flight assist is matching
 *   FTL      mass lock (and how far to climb out) and which gravity well caps FTL speed
 *   Star     light and solar power, shadow, and how far the scoop zones are
 */
import { AU, C, WT } from '../constants';
import { fmtDist, fmtPower, fmtSpeedText } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { dropAlt, ftlSpeedLimit, massLock, wellFactor } from '../sim/ftl';
import type { Body } from '../types';
import type { InfluencesView, Readout } from './types';

const tmp = new THREE.Vector3();
const G0 = 9.80665;

/** Where something is relative to the nose, in words: "ahead", "12° right, below"… */
function bearing(g: Game, dir: THREE.Vector3) {
  const v = tmp.copy(dir).applyQuaternion(g.qInv); // ship frame: −z ahead, +x right, +y up
  const off = (Math.acos(Math.max(-1, Math.min(1, -v.z))) * 180) / Math.PI;
  if (off < 10) return 'ahead';
  if (off > 170) return 'behind';
  const side = Math.abs(v.x) > Math.abs(v.y) ? (v.x > 0 ? 'right' : 'left') : v.y > 0 ? 'above' : 'below';
  return `${Math.round(off)}° ${side}`;
}

const fmtG = (a: number) => {
  const gs = a / G0;
  return gs >= 0.01 ? `${gs.toFixed(gs < 1 ? 3 : 2)} g` : `${a < 1e-4 ? a.toExponential(1) : a.toFixed(4)} m/s²`;
};

export function buildInfluences(g: Game): InfluencesView {
  const { ship, power } = g;
  const dom = ship.grav?.body ?? g.frameBody;

  // gravity: every body's pull, strongest first
  const pulls = g.cur.bodies
    .map((b) => {
      const rel = b.pos.clone().sub(ship.pos);
      const r = rel.length();
      return { b, a: b.mu / (r * r), dir: rel.divideScalar(r), r };
    })
    .sort((x, y) => y.a - x.a);
  const top = pulls[0]?.a ?? 1;
  const gravity = pulls.slice(0, 5).map((p) => ({
    name: p.b.name,
    value: fmtG(p.a),
    detail: `${bearing(g, p.dir)} · ${fmtDist(p.r - p.b.radius)} up`,
    frac: p.a / top,
    applied: p.b === dom,
  }));

  // frame: sphere of influence and what flight assist matches
  const frame: [string, string | Readout][] = [];
  const r = ship.pos.distanceTo(dom.pos);
  frame.push(['IN THE GRAVITY OF', dom.kind === 'star' ? `${dom.name} (the star)` : `${dom.name} · edge ${fmtDist(Math.max(0, dom.soi - r))} away`]);
  const children = g.cur.bodies.filter((b): b is Exclude<Body, { kind: 'star' }> => b.kind !== 'star' && b.parent === dom);
  const next = children.map((b) => ({ b, d: ship.pos.distanceTo(b.pos) - b.soi })).sort((x, y) => x.d - y.d)[0];
  if (next) frame.push(['NEXT GRAVITY WELL', `${next.b.name} · ${fmtDist(Math.max(0, next.d))}`]);
  frame.push(['FLIGHT ASSIST FRAME', g.refFrame ? `${g.refFrame.name} (station)` : `${g.frameBody.name}`]);

  // FTL: mass lock and the well capping the drive
  const ftl: [string, string | Readout][] = [];
  const lock = massLock(g);
  if (lock) {
    const climb = dropAlt(lock) * 1.15 - (ship.pos.distanceTo(lock.pos) - lock.radius);
    ftl.push(['MASS LOCK', { text: `${lock.name} · climb ${fmtDist(Math.max(0, climb))} to clear`, warn: true }]);
  } else ftl.push(['MASS LOCK', 'clear · FTL can start']);
  let capBody: Body | null = null,
    cap = Infinity;
  for (const b of g.cur.bodies) {
    const v = (Math.max(0, b.pos.distanceTo(ship.pos) - b.radius) / wellFactor(b)) * 0.9;
    if (v < cap) {
      cap = v;
      capBody = b;
    }
  }
  const vmax = ftlSpeedLimit(g);
  ftl.push(['FTL SPEED LIMIT', `${vmax >= C ? (vmax / C).toFixed(vmax < 10 * C ? 2 : 0) + ' c' : fmtSpeedText(vmax)}${capBody ? ` · set by ${capBody.name}'s well` : ''}`]);

  // star, light and fuel
  const star = g.cur.star;
  const starAlt = ship.pos.distanceTo(star.pos) - star.radius;
  const light: [string, string | Readout][] = [];
  light.push(['STARLIGHT', `${power.flux.toFixed(power.flux < 10 ? 2 : 0)} × Earth's · ${(ship.pos.distanceTo(star.pos) / AU).toFixed(3)} AU from ${star.name}`]);
  light.push(['SOLAR POWER', power.shadow ? { text: `none · in ${power.shadow.name}'s shadow`, warn: true } : `${fmtPower(power.solar)} (panels ${Math.round((Math.acos(Math.max(-1, Math.min(1, power.cos))) * 180) / Math.PI)}° off the star)`]);
  light.push(['CORONA SCOOP', starAlt < star.radius * 1.5 ? { text: 'in range · skimming', warn: false } : `${fmtDist(starAlt - star.radius * 1.5)} to go`]);
  const giants = g.cur.bodies
    .filter((b) => b.kind !== 'star' && b.type >= WT.GasGiant)
    .map((b) => ({ b, d: ship.pos.distanceTo(b.pos) - b.radius * 1.05 }))
    .sort((x, y) => x.d - y.d);
  if (giants[0]) light.push(['GAS GIANT SCOOP', giants[0].d < 0 ? `in ${giants[0].b.name}'s band` : `${giants[0].b.name} · ${fmtDist(giants[0].d)} to its band`]);

  return { gravity, frame, ftl, light };
}
