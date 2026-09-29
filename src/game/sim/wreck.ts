/**
 * Wrecks (docs/damage.md, "Wrecks and salvage"): a ship you lose with metal in its hold leaves a
 * wreck, its distress beacon still calling, so it's marked on the HUD from anywhere in the system
 * and can be targeted like anything else. Fly up to it and match its speed (within SALVAGE_R, under
 * SALVAGE_V) and the metal is moved across into your hold, as much as there's room for.
 *
 *   - In space it falls on along the path the ship had, round the world it was nearest (patched
 *     conics, like the ship): a wreck in orbit stays in orbit, one knocked off a station drifts away.
 *   - One that came down on a world (or falls into it) rests where it hit, turning with the world.
 *   - One that fell into a star is gone.
 *   - Contract crates aren't salvaged: the client wrote them off with the ship (sim/contracts.ts).
 *   - The newest WRECKS_KEPT are kept (per game, all systems), saved with the game.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import type { Body, Wreck, World } from '../types';
import { CARGO_CAP, cargoMass, type Commodity } from './economy';
import { fmtClock } from '../format';
import { surfaceRadius, worldQuat } from './terrain';
import { dominantBody } from './gravity';

export const SALVAGE_R = 150,
  SALVAGE_V = 10,
  WRECKS_KEPT = 3;
/** A wreck's size (m), for markers and clicks. */
const WRECK_R = 30;
/** Integration step for a wreck's fall (s): stable for orbits of an hour and up. */
const MAX_STEP = 2;

const metalIn = (cargo: Wreck['cargo']) => (Object.values(cargo) as number[]).reduce((a, b) => a + (b ?? 0), 0);

/** Wrecks in the system you're in. */
export const wrecksHere = (g: Game) => g.wrecks.filter((w) => w.sys === g.cur.sys.id);

const q = new THREE.Quaternion(),
  tmp = new THREE.Vector3();

/** The ship is lost (sim/flight.ts destroyShip, before its velocity is cleared): leave a wreck with its metal. */
export function leaveWreck(g: Game) {
  const { ship } = g;
  const cargo = { ...ship.cargo };
  if (metalIn(cargo) < 1) return; // nothing worth coming back for
  const body = g.frameBody;
  const rel = ship.pos.clone().sub(body.pos);
  if (body.kind === 'star' && rel.length() < body.radius * 1.2) return; // into the star: nothing left
  const w: Wreck = {
    kind: 'wreck',
    name: `Wreck (lost ${fmtClock(g.simTime)})`,
    radius: WRECK_R,
    sys: g.cur.sys.id,
    body: body.name,
    pos: ship.pos.clone(),
    vel: ship.vel.clone().add(body.vel),
    rel,
    relVel: ship.vel.clone(),
    ground: null,
    cargo,
    lostAt: g.simTime,
  };
  if (body.kind !== 'star' && (ship.landed || rel.length() - surfaceRadius(body, ship.pos) < 200)) settle(w, body);
  g.wrecks.push(w);
  while (g.wrecks.length > WRECKS_KEPT) g.wrecks.shift();
}

/** Put a wreck down on its world's ground, fixed in the world's own (turning) frame. */
function settle(w: Wreck, b: World) {
  const up = w.rel.clone().normalize();
  const local = up.multiplyScalar(surfaceRadius(b, tmp.copy(b.pos).add(w.rel)) + 3).applyQuaternion(worldQuat(b, q).invert());
  w.ground = local;
}

/** Each step: move the wrecks in this system (falling, or turning with their world), then salvage. */
export function updateWrecks(g: Game, dt: number) {
  const here = wrecksHere(g);
  if (!here.length) return;
  for (const w of here) {
    const b = g.cur.bodies.find((x) => x.name === w.body) ?? dominantBody(g.cur, w.pos);
    if (w.ground && b.kind !== 'star') {
      const wq = worldQuat(b, q);
      w.rel.copy(w.ground).applyQuaternion(wq);
      w.relVel.copy(b.axis).multiplyScalar(b.spin).cross(w.rel);
    } else if (dt > 0) {
      // leapfrog under the one world's gravity (patched conics), in steps it stays stable at
      const n = Math.max(1, Math.ceil(dt / MAX_STEP));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        const r = w.rel.length();
        w.relVel.addScaledVector(w.rel, (-b.mu / (r * r * r)) * h);
        w.rel.addScaledVector(w.relVel, h);
      }
      if (b.kind !== 'star' && w.rel.length() < surfaceRadius(b, tmp.copy(b.pos).add(w.rel)) + 3) settle(w, b);
      else if (b.kind === 'star' && w.rel.length() < b.radius) {
        g.wrecks = g.wrecks.filter((x) => x !== w);
        continue;
      }
    }
    w.pos.copy(b.pos).add(w.rel);
    w.vel.copy(b.vel).add(w.relVel);
  }
  salvage(g);
}

/** Close to a wreck and matched with it: its metal comes across, as far as the hold has room. */
function salvage(g: Game) {
  const { ship } = g;
  if (ship.dead || ship.mode !== 'normal') return;
  const v = tmp.copy(ship.vel).add(g.frameBody.vel);
  for (const w of wrecksHere(g)) {
    if (w.pos.distanceTo(ship.pos) > SALVAGE_R + w.radius) continue;
    const dv = v.distanceTo(w.vel);
    if (dv > SALVAGE_V) {
      if (!g.warned.salvage) {
        g.warned.salvage = true;
        g.showMsg(`Match the wreck's speed to salvage it · ${dv.toFixed(0)} m/s off (under ${SALVAGE_V})`, 'warn');
      }
      continue;
    }
    g.warned.salvage = false;
    const room = Math.max(0, CARGO_CAP - cargoMass(g));
    const total = metalIn(w.cargo);
    const f = total > 0 ? Math.min(1, room / total) : 0;
    let took = 0;
    for (const c of Object.keys(w.cargo) as Commodity[]) {
      const kg = (w.cargo[c] ?? 0) * f;
      ship.cargo[c] = (ship.cargo[c] ?? 0) + kg;
      w.cargo[c] = (w.cargo[c] ?? 0) - kg;
      took += kg;
    }
    const left = metalIn(w.cargo);
    if (left < 1) {
      g.wrecks = g.wrecks.filter((x) => x !== w);
      if (g.target === w) g.target = null;
      g.showMsg(`Salvaged ${(took / 1000).toFixed(1)} t of metal from the wreck · it's been stripped`);
    } else if (took >= 1) g.showMsg(`Salvaged ${(took / 1000).toFixed(1)} t of metal · the hold is full, ${(left / 1000).toFixed(1)} t still aboard the wreck`, 'warn');
  }
}

/** The metal aboard a wreck (kg), for the HUD. */
export const wreckMetal = (w: Wreck) => metalIn(w.cargo);

/** Find a wreck's world again after a save (by name), for code that needs the Body. */
export const wreckBody = (g: Game, w: Wreck): Body | undefined => g.cur.bodies.find((x) => x.name === w.body);
