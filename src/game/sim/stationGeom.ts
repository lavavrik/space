/*
 * The shape of a Coriolis-style station, in its own frame, in units of its edge length S (so the
 * cube runs −0.5…0.5 on each axis):
 *
 *   - It spins about its local +z axis, which points out through the front face.
 *   - A docking slot (SLOT_W × SLOT_H) is cut in the middle of the front face, on the spin axis, so
 *     it turns in place: line up with it and roll to match.
 *   - A short tunnel runs from the slot to the hangar.
 *   - The hangar is a cylinder about the spin axis (radius HANGAR_R, from HANGAR_Z0 at the back to
 *     HANGAR_Z1 at the front wall).
 *   - Landing pads sit on the hangar's curved wall. The spin makes that wall "down": at HANGAR_R the
 *     station turns fast enough for ~0.5 g there (spinRateFor).
 *
 * Everything here is pure geometry. Docking logic is in sim/docking.ts; the mesh is in
 * render/stationMesh.ts; the hull shader already paints the slot's rim at the same size.
 */
import { THREE } from '../lib/three';
import type { Body, Station } from '../types';
import { DEPOT_PAD_COUNT, PLATE_X, depotPadLocal, depotWhereIs, overPlate } from './depotGeom';
import { SKY_PAD_COUNT, overDeck, skyPadLocal, skyWhereIs } from './skyGeom';
import { worldQuat } from './terrain';

export const SLOT_W = 0.4,
  SLOT_H = 0.12;
/** The tunnel from the slot (front face, z = 0.5) back to the hangar's front wall. */
export const TUNNEL_Z = 0.4;
/** The entry corridor's length in front of the slot, along the spin axis (m): drawn by render/stationMesh.ts, flown by the docking computer. */
export const CORRIDOR_M = 5000;
export const HANGAR_R = 0.42,
  HANGAR_Z0 = -0.42,
  HANGAR_Z1 = TUNNEL_Z;

/** Pads: PAD_COLS around the wall at each of PAD_ROWS positions along the axis. */
export const PAD_ROWS = [0.2, -0.04, -0.28];
export const PAD_COLS = 6;
/** Pad radius (unit coordinates): 40 m on a 1 km station, enough for the 60 m ship to sit on. */
export const PAD_R = 0.04;
export const PAD_COUNT = PAD_ROWS.length * PAD_COLS;

/** Artificial gravity on the hangar wall, in g. */
const WALL_G = 0.5;

/** Spin rate (rad/s) that gives WALL_G on the hangar wall of a station S metres across. */
export const spinRateFor = (size: number) => Math.sqrt((WALL_G * 9.81) / (HANGAR_R * size));

/** Pad `i` (0-based): its centre on the wall and its "up" (toward the axis), in unit coordinates. */
export function padLocal(i: number) {
  const row = Math.floor(i / PAD_COLS),
    col = i % PAD_COLS;
  const phi = (col / PAD_COLS) * Math.PI * 2 + (row % 2) * (Math.PI / PAD_COLS); // rows staggered
  const c = Math.cos(phi),
    s = Math.sin(phi);
  // a docked ship faces along the axis, toward the slot
  return { pos: new THREE.Vector3(HANGAR_R * c, HANGAR_R * s, PAD_ROWS[row]), up: new THREE.Vector3(-c, -s, 0), fwd: new THREE.Vector3(0, 0, 1), phi };
}

/** Pad `i` of any station: a cube's hangar wall, a sky deck (sim/skyGeom.ts) or a depot's plate (sim/depotGeom.ts). */
export const padOf = (st: Station, i: number) => (st.depot ? depotPadLocal(i) : st.sky ? skyPadLocal(i) : padLocal(i));
/** How many pads the station has. */
export const padCount = (st: Station) => (st.depot ? DEPOT_PAD_COUNT : st.sky ? SKY_PAD_COUNT : PAD_COUNT);
/** whereIs for any station. */
export const whereIsAt = (st: Station, p: THREE.Vector3, m: number) => (st.depot ? depotWhereIs(p, m) : st.sky ? skyWhereIs(p, m) : whereIs(p, m));

/** An open deck, landed on from above, with no hangar and no slot: a sky station or a depot. */
export const isDeck = (st: Station) => !!(st.sky || st.depot);

/** Is a point (unit coordinates, above the deck) over the station's landing deck, within `m` of its edge? */
export const overDeckAt = (st: Station, p: THREE.Vector3, m: number) => (st.depot ? overPlate(p, m) : overDeck(p, m));

/**
 * Where an approach hold point is, over the deck, in unit coordinates: straight above the middle of
 * a sky deck or of a depot's plate.
 */
export const deckCentre = (st: Station) => (st.depot ? PLATE_X : 0);

/** The body a station's orbit goes round: its world's, or for a depot at a Lagrange point, the planet's parent. */
export const orbitBody = (st: Station): Body => (st.depot ? st.parent.parent : st.parent);

const Z = new THREE.Vector3(0, 0, 1);

const qSky = new THREE.Quaternion();

/**
 * The station's orientation at time t: local +z along its spin axis, turned by its spin. A sky
 * station's +z is its local vertical, turning with its world (at the world's current rotation, which
 * is always the sim clock's: stations only move after the worlds).
 */
export function stationQuat(st: Station, t: number, out = new THREE.Quaternion()) {
  if (st.depot) return out.copy(st.depot.q); // fixed in space: it doesn't turn
  if (st.sky) return worldQuat(st.parent, out).multiply(qSky.setFromUnitVectors(Z, st.sky.dir));
  const base = out.setFromUnitVectors(Z, st.spinAxis);
  return base.premultiply(new THREE.Quaternion().setFromAxisAngle(st.spinAxis, st.spinRate * t));
}

/** Where a volume test puts a point (unit coordinates): outside the hull, in open space inside it, or in a wall. */
export type Where = 'outside' | 'tunnel' | 'hangar' | 'wall';

/**
 * Classify a point (unit coordinates) with a clearance `m` (unit coordinates too) for the ship's
 * size: it's 'wall' if it's inside the cube but not in the slot, tunnel or hangar with room to spare.
 */
export function whereIs(p: THREE.Vector3, m: number): Where {
  const h = 0.5 + m;
  if (Math.abs(p.x) > h || Math.abs(p.y) > h || Math.abs(p.z) > h) return 'outside';
  // the slot and tunnel: a box from the front face back to the hangar's front wall
  if (p.z > TUNNEL_Z - m && Math.abs(p.x) < SLOT_W / 2 - m && Math.abs(p.y) < SLOT_H / 2 - m) return p.z >= TUNNEL_Z ? 'tunnel' : 'hangar';
  const r = Math.hypot(p.x, p.y);
  if (p.z < HANGAR_Z1 - m && p.z > HANGAR_Z0 + m && r < HANGAR_R - m) return 'hangar';
  return 'wall';
}

/** World position → station unit coordinates at time t. */
export function toLocal(st: Station, t: number, world: THREE.Vector3, out = new THREE.Vector3()) {
  const q = stationQuat(st, t).invert();
  return out.subVectors(world, st.pos).applyQuaternion(q).divideScalar(st.size);
}

/** Station unit coordinates → world position at time t. */
export function toWorld(st: Station, t: number, local: THREE.Vector3, out = new THREE.Vector3()) {
  return out.copy(local).multiplyScalar(st.size).applyQuaternion(stationQuat(st, t)).add(st.pos);
}

/**
 * Velocity (m/s, system frame) of the station's structure at a world point: its orbit plus its
 * spin (ω × r). Flight assist matches this inside the station, so "all stop" means at rest
 * against the turning hangar.
 */
export function stationPointVel(st: Station, world: THREE.Vector3, out = new THREE.Vector3()) {
  return stationPointVelAt(st, world.clone().sub(st.pos), out);
}

/** The same, for a point given by its offset from the station's centre (m). */
export function stationPointVelAt(st: Station, rel: THREE.Vector3, out = new THREE.Vector3()) {
  const w = st.spinAxis.clone().multiplyScalar(st.spinRate);
  return out.crossVectors(w, rel).add(st.vel);
}
