/**
 * Ships hitting ships (docs/traffic.md): yours and the others (sim/traffic.ts), each a sphere of
 * SHIP_HIT_R (their ~60 m hulls). A contact bounces them apart (momentum kept, BOUNCE of the closing
 * speed back, the lighter ship thrown further) and damages both from that closing speed, over the
 * same kind of curve as a station's structure: nothing under SHIP_SCRAPE, a whole hull at SHIP_CRASH.
 *
 * Not in FTL (the drive's bubble doesn't meet anything), nor for a ship docked or landed (held in
 * place: two on neighbouring pads never touch anyway). Once a step, after everything has moved.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { pilotName, pilots } from './control';
import { hurt, impactDamage } from './damage';
import { shipMass } from './resources';

export const SHIP_HIT_R = 30;
const BOUNCE = 0.3,
  SHIP_SCRAPE = 3,
  SHIP_CRASH = 50;

const va = new THREE.Vector3(),
  vb = new THREE.Vector3(),
  n = new THREE.Vector3();

const flying = (p: Game) => !p.ship.dead && p.ship.mode === 'normal' && !p.dock?.docked && !p.ship.landed;

export function shipContacts(g: Game) {
  const all = pilots(g).filter(flying);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i],
        b = all[j];
      n.subVectors(b.ship.pos, a.ship.pos);
      const d = n.length();
      if (d >= 2 * SHIP_HIT_R || d < 1e-6) continue;
      n.divideScalar(d);
      // system-frame velocities (each pilot's ship.vel is relative to its own frame body)
      va.copy(a.ship.vel).add(a.frameBody.vel);
      vb.copy(b.ship.vel).add(b.frameBody.vel);
      const closing = va.sub(vb).dot(n);
      // apart: out of the overlap, each by the other's share of the mass
      const ma = shipMass(a.ship),
        mb = shipMass(b.ship);
      const over = 2 * SHIP_HIT_R - d;
      a.ship.pos.addScaledVector(n, (-over * mb) / (ma + mb));
      b.ship.pos.addScaledVector(n, (over * ma) / (ma + mb));
      if (closing <= 0) continue; // already separating
      // the bounce: an impulse along the line between them
      const J = ((1 + BOUNCE) * closing) / (1 / ma + 1 / mb);
      a.ship.vel.addScaledVector(n, -J / ma);
      b.ship.vel.addScaledVector(n, J / mb);
      // damage: each by its own change of speed (the lighter ship's is the bigger), on the scale of
      // the closing speed that would take a whole hull from both of two equal ships
      for (const [p, dv, other] of [
        [a, J / ma, b],
        [b, J / mb, a],
      ] as const) {
        const v = (dv / (1 + BOUNCE)) * 2; // (equal masses: the closing speed)
        const dmg = impactDamage(v, SHIP_SCRAPE, SHIP_CRASH);
        if (dmg > 0) hurt(p, dmg, `Collided with ${pilotName(g, other)} at ${closing.toFixed(0)} m/s`, p.frameBody);
        else if (p === g && closing > 0.5) g.showMsg(`Bumped ${pilotName(g, other)} at ${closing.toFixed(1)} m/s`, 'warn');
      }
    }
  }
}
