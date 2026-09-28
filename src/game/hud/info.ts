/* Body info panel (I): everything about the current target, and where the ship stands relative to it. */
import { surfaceDist } from '../sim/terrain';
import { AU, MSUN, REARTH } from '../constants';
import { fmtDist, fmtSpeedText, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { velRel } from '../sim/frame';
import { orbitElementsRel } from '../sim/gravity';
import { resolvable, SCAN_STAGE, scanProgress } from '../sim/scanner';
import { npcStatus } from '../sim/traffic';
import type { Body, KeplerOrbit, Npc, Station, Target, World } from '../types';
import { atmoOf, type Atmo } from '../sim/atmosphere';
import { HULL, SIGMA, TEMP, heatCap } from '../sim/thermal';
import type { InfoView, Readout } from './types';

const MEARTH = 5.972e24;
const DEG = 180 / Math.PI;
const tmp = new THREE.Vector3();

const sci = (x: number) => x.toExponential(2).replace('e+', 'e');
const fmtMassBody = (kg: number) => (kg > 0.05 * MSUN ? `${(kg / MSUN).toFixed(2)} M☉` : kg > 0.01 * MEARTH ? `${(kg / MEARTH).toFixed(2)} M⊕` : `${sci(kg)} kg`);
const fmtRadius = (m: number) => (m > 3e8 ? `${(m / 6.957e8).toFixed(2)} R☉ · ${fmtDist(m)}` : m > 0.1 * REARTH ? `${(m / REARTH).toFixed(2)} R⊕ · ${fmtDist(m)}` : fmtDist(m));
/** Orbit distances: AU around a star, km around a world. */
const fmtOrbitDist = (m: number, aroundStar: boolean) => (aroundStar ? `${(m / AU).toFixed(3)} AU` : fmtDist(m));

export function buildInfo(g: Game, t: Target): InfoView {
  // what the scanner has revealed so far (see sim/scanner.ts); your own position and speed
  // relative to it come from the ship's instruments and are always shown
  if (t.kind === 'ship') return shipInfo(g, t);
  const p = scanProgress(g, t);
  const unknown: [string, string] = ['SCAN', scanHint(g, t, p)];
  let physical: [string, string][] = t.kind === 'station' ? stationPhysical(t) : bodyPhysical(g, t);
  if (p < SCAN_STAGE.type) physical = [unknown];
  else if (p < SCAN_STAGE.physical) physical = [physical[0], unknown];
  else if (p < SCAN_STAGE.full) physical = [...physical.slice(0, t.kind === 'station' ? 1 : 3), unknown];
  let orbitHead = 'ANCHORS THE SYSTEM';
  let orbit: [string, string][] = [['ORBIT', 'none · everything here orbits it']];
  if (t.kind !== 'star') {
    const par = t.parent;
    orbitHead = `ORBITS ${par.name.toUpperCase()}`;
    orbit = p >= SCAN_STAGE.orbit ? orbitRows(t.kind === 'station' ? t : t.orb, t, par) : [['ORBIT', 'unknown · scan to 75 %']];
  }
  const type = p < SCAN_STAGE.type ? 'UNKNOWN · UNSCANNED' : t.kind === 'station' ? 'ORBITAL STATION' : t.typeName.toUpperCase();
  return { title: t.name, type, physical, orbitHead, orbit, you: youRows(g, t) };
}

/**
 * Another ship: its class and size once scanned to 25 %, what it's doing at 50 %, where it's going
 * at 75 % (sim/traffic.ts), and its distance and speed relative to you always.
 */
function shipInfo(g: Game, t: Npc): InfoView {
  const p = scanProgress(g, t);
  const hint: [string, string] = ['SCAN', scanHint(g, t, p)];
  const physical: [string, string][] = p >= SCAN_STAGE.type ? [['CLASS', t.cls], ['LENGTH', '≈ 60 m']] : [hint];
  const orbit: [string, string][] = [];
  if (p >= SCAN_STAGE.physical) orbit.push(['STATUS', npcStatus(t)]);
  if (p >= SCAN_STAGE.orbit) orbit.push(['BOUND FOR', t.to ? t.to.name : `${t.at?.name ?? '—'} (staying)`]);
  if (p < SCAN_STAGE.orbit) orbit.push(hint);
  const rv = g.ship.pos.clone().sub(t.pos);
  const v = g.ship.vel.clone().add(g.frameBody.vel).sub(t.vel);
  const you: [string, string | Readout][] = [
    ['DISTANCE', fmtDist(rv.length())],
    ['RELATIVE SPEED', g.ship.mode === 'ftl' ? 'in FTL' : fmtSpeedText(v.length())],
  ];
  return { title: p >= SCAN_STAGE.type ? `${t.cls} ${t.name}` : 'Unidentified ship', type: p >= SCAN_STAGE.type ? t.cls.toUpperCase() : 'SHIP · UNSCANNED', physical, orbitHead: 'ACTIVITY', orbit, you };
}

/** What to say where scan data is missing. */
function scanHint(g: Game, t: Target, p: number) {
  if (g.scanning === t) return `scanning · ${Math.floor(p * 100)} %`;
  if (!g.ship.avionics.scanner) return 'no scanner fitted';
  const r = resolvable(g, t);
  if (!r.ok) return `out of resolution · close to ${fmtDist(r.needDist)}`;
  return p > 0 ? `${Math.floor(p * 100)} % scanned · Y to continue` : 'unscanned · Y to scan';
}

function bodyPhysical(g: Game, b: Body): [string, string][] {
  const rows: [string, string][] = [
    ['RADIUS', fmtRadius(b.radius)],
    ['MASS · GRAVITY', `${fmtMassBody(b.mass)} · ${(b.mu / b.radius ** 2 / 9.80665).toFixed(2)} g`],
    ['ESCAPE VELOCITY', fmtSpeedText(Math.sqrt((2 * b.mu) / b.radius))],
  ];
  if (b.kind === 'star') {
    rows.push(['LUMINOSITY', `${b.L.toFixed(b.L < 10 ? 3 : 0)} L☉ · ${Math.round(g.cur.sys.star.T)} K`]);
    rows.push(['DAY', fmtTime((2 * Math.PI) / b.spin)]);
    rows.push(['PLANETS', String(g.cur.bodies.filter((m) => m.kind === 'planet').length)]);
    return rows;
  }
  const air = atmoOf(b);
  const stations = g.cur.stations.filter((s) => s.parent === b).map((s) => s.name);
  const moons = g.cur.bodies.filter((m) => m.kind === 'moon' && m.parent === b).length;
  rows.push(...airRows(g, b, air));
  rows.push(
    ['DAY · TILT', `${fmtTime((2 * Math.PI) / b.spin)} · ${(b.tilt * DEG).toFixed(1)}°`],
    ['SPHERE OF INFLUENCE', fmtDist(b.soi)],
    [b.kind === 'planet' ? 'MOONS · STATIONS' : 'STATIONS', (b.kind === 'planet' ? `${moons} · ` : '') + (stations.length ? stations.join(', ') : 'none')],
  );
  if (b.ring) rows.push(['RINGS', `${b.ring.inner.toFixed(2)}–${b.ring.outer.toFixed(2)} radii`]);
  return rows;
}

/** The world's air (sim/atmosphere.ts): climate, pressure and density, what it's made of, how tall it is, and what it does to a ship on the ground. */
function airRows(g: Game, b: World, a: Atmo | null): [string, string][] {
  const C = (K: number) => `${Math.round(K - 273)} °C`;
  if (!a) return [['CLIMATE', `${C(b.T)} · airless`]];
  const giant = b.type >= 6;
  const gh = a.Ts - b.T;
  const bar = a.P0 / 1e5;
  const rows: [string, string][] = [
    ['CLIMATE', giant ? `${C(a.Ts)} at the cloud tops` : `${C(a.Ts)} at the surface${gh > 5 ? ` · greenhouse +${Math.round(gh)} K` : ''}`],
    ['ATMOSPHERE', `${fmtBar(bar)}${giant ? ' at the cloud tops' : ''} · ${fmtRho(a.rho0)}${a.rho0 > 2.4 || a.rho0 < 0.6 ? ` (${fmtX(a.rho0 / 1.225)} Earth)` : ''}`],
    ['COMPOSITION', a.gases.slice(0, 3).map(([gas, x]) => `${gas} ${fmtPct(x)}`).join(' · ')],
    ['AIR COLUMN', `scale height ${fmtDist(a.H)} · ends ${fmtDist(a.top)} up`],
  ];
  // on the ground, the hot air heats the hull by convection and by its infrared glow (all the sky
  // under thick air), as in sim/thermal.ts: roughly how fast, from the hull's temperature now
  if (!giant && a.Ts > TEMP.warn) {
    const T = g.ship.temp;
    const conv = 15 * Math.sqrt(a.rho0 / 1.2) * HULL.area * (a.Ts - T);
    const glow = HULL.emit * SIGMA * HULL.area * ((1 - Math.exp(-a.tau)) * a.Ts ** 4 - T ** 4);
    const rate = (conv + glow) / heatCap(g.ship); // K/s
    const note = a.Ts > TEMP.fail && rate > 0 ? `lethal · the hull fails in ~${fmtTime((TEMP.fail - T) / rate)}` : a.Ts > TEMP.drives ? `hot · the hull heads for ${C(a.Ts)}: drives can't charge` : `hot · the hull heads for ${C(a.Ts)}`;
    rows.push(['ON THE GROUND', note]);
  }
  return rows;
}

const fmtBar = (bar: number) => (bar < 0.01 ? `${(bar * 1000).toFixed(1)} mbar` : bar < 10 ? `${bar.toFixed(bar < 1 ? 3 : 2)} bar` : `${Math.round(bar)} bar`);
const fmtRho = (r: number) => `${r < 0.1 ? r.toFixed(3) : r < 10 ? r.toFixed(2) : Math.round(r)} kg/m³`;
const fmtX = (x: number) => (x < 0.1 ? `${Math.round(x * 100)} % of` : `${x < 10 ? x.toFixed(1) : Math.round(x)}×`);
const fmtPct = (x: number) => `${x < 0.001 ? '<0.1' : x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100)} %`;

function stationPhysical(st: Station): [string, string][] {
  return [['SIZE · SPIN', `${fmtDist(st.size)} cube · ${fmtTime((2 * Math.PI) / Math.abs(st.spinRate))} per turn`]];
}

/** Orbital elements of `o` around `p`, plus where the body is on that orbit right now. */
function orbitRows(o: KeplerOrbit, t: Target, p: Body): [string, string][] {
  const aroundStar = p.kind === 'star';
  const d = (m: number) => fmtOrbitDist(m, aroundStar);
  // around a star, distances from its centre; around a world, altitudes above its surface
  const alt = (r: number) => (aroundStar ? d(r) : fmtDist(r - p.radius));
  const rel = tmp.subVectors(t.pos, p.pos);
  const vrel = t.vel.clone().sub(p.vel);
  const normal = new THREE.Vector3().crossVectors(o.P, o.Q);
  // inclination: to the system plane around a star, to the parent's equator around a world
  const ref = aroundStar ? new THREE.Vector3(0, 1, 0) : p.axis;
  const inc = Math.acos(Math.max(-1, Math.min(1, normal.dot(ref)))) * DEG;
  return [
    ['SEMI-MAJOR AXIS · e', `${d(o.a)} · ${o.e.toFixed(3)}`],
    [aroundStar ? 'PERIHELION – APHELION' : 'PERIAPSIS – APOAPSIS', `${alt(o.a * (1 - o.e))} – ${alt(o.a * (1 + o.e))}`],
    ['INCLINATION · PERIOD', `${inc.toFixed(1)}°${inc > 90 ? ' retro' : ''} · ${fmtTime((2 * Math.PI) / o.n)}`],
    ['NOW', `${alt(rel.length())} · ${fmtSpeedText(vrel.length())}`],
  ];
}

/** The ship relative to the target: distance, speeds, and its own orbit around it if any. */
function youRows(g: Game, t: Body | Station): [string, string | Readout][] {
  const { ship } = g;
  const rv = ship.pos.clone().sub(t.pos);
  const r = rv.length();
  const v = t.kind === 'station' ? ship.vel.clone().add(g.frameBody.vel).sub(t.vel) : velRel(g, t);
  const vr = v.dot(rv) / r;
  const rows: [string, string | Readout][] = [
    [t.kind === 'station' ? 'DISTANCE' : 'ALTITUDE', fmtDist(t.kind === 'station' ? r - t.size / 2 : surfaceDist(t, g.ship.pos))],
    ['SPEED · VERTICAL', ship.mode === 'ftl' ? 'in FTL' : `${fmtSpeedText(v.length())} · ${vr >= 0 ? '+' : '−'}${fmtSpeedText(Math.abs(vr))}`],
  ];
  if (t.kind === 'station') {
    rows.push(['FRAME', g.refFrame === t ? 'matched · flight assist holds you here' : 'not matched · matches within 5,000 km while targeted']);
    return rows;
  }
  if (ship.landed === t) {
    rows.push(['STATUS', { text: 'landed' }]);
    return rows;
  }
  if (ship.mode === 'ftl') {
    rows.push(['STATUS', 'in FTL']);
    return rows;
  }
  // an orbit only means something where this body's gravity is the one that counts: not inside a
  // planet or moon circling it, and not outside its own sphere of influence
  const fb = g.frameBody;
  if (fb !== t && fb.kind !== 'star' && (fb.parent === t || (fb.parent.kind !== 'star' && fb.parent.parent === t))) {
    rows.push(['STATUS', `inside ${fb.name}'s gravity`]);
    return rows;
  }
  if (t.kind !== 'star' && r > t.soi) {
    rows.push(['STATUS', `outside its gravity (${fmtDist(r - t.soi)} beyond the SOI)`]);
    return rows;
  }
  const oe = orbitElementsRel(rv, v, t.mu);
  const R = t.radius;
  if (oe.escape) rows.push(['STATUS', 'escape trajectory'], ['PERIAPSIS', fmtDist(oe.pe - R)]);
  else if (oe.pe < R) rows.push(['STATUS', { text: 'suborbital · will hit the surface', warn: true }], ['APOAPSIS', fmtDist(oe.ap - R)]);
  else {
    const e = (oe.ap - oe.pe) / (oe.ap + oe.pe);
    const out = t.kind !== 'star' && oe.ap > t.soi;
    rows.push(
      ['STATUS', { text: out ? 'in orbit · leaves the SOI at apoapsis' : 'in orbit', warn: out }],
      ['PERIAPSIS – APOAPSIS', `${fmtDist(oe.pe - R)} – ${fmtDist(oe.ap - R)}`],
      ['e · PERIOD', `${e.toFixed(3)} · ${fmtTime(oe.period)}`],
    );
  }
  return rows;
}
