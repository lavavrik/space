/**
 * Debug jumps (the pause menu's "Jump to" list; dev builds, or any build with `?debug` in the URL):
 * put the ship somewhere telling for checking how things look, moving sensibly there, facing the
 * subject. Only the spots this system has are offered.
 *
 *   - belt: inside the nearest ringed world's belt, orbiting with it (rocks, their shadows, the dust)
 *   - ring shadow: the ringed world from its sunward side (the ring's shadow on it)
 *   - above / under the clouds: over and below a clouded world's deck (volumetric clouds, light shafts)
 *   - re-entry: 75 km up at 7.6 km/s, descending (plasma)
 *   - station, sky station: in front of one, matched with it (shadows, exhaust of the traffic)
 *   - star: 1 AU out, looking past it (bloom, lens flare)
 *   - wreck: beside the nearest wreck (its debris)
 *   - deep space: far above the system, nothing near (the Milky Way, the sky)
 *
 * The same spots are `farlightPose` in the console in dev builds (ui/hooks/useGame.ts).
 */
import type { Game } from '../Game';
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { atmoOf } from '../sim/atmosphere';
import { cloudCoverAt } from '../sim/clouds';
import { resetFrame } from '../sim/frame';
import { stationQuat } from '../sim/stationGeom';
import { surfaceRadius } from '../sim/terrain';
import { wreckBody, wrecksHere } from '../sim/wreck';
import type { Body, World } from '../types';

/** Debug tools on: dev builds, or `?debug` in the URL. */
export const DEBUG = import.meta.env.DEV || new URLSearchParams(location.search).has('debug');

export interface Spot {
  id: string;
  label: string;
  hint: string;
  go: () => void;
}

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Put the ship at `pos` moving at `vel` relative to `frame`, looking along `fwd` with `up` up. */
function place(g: Game, frame: Body, pos: THREE.Vector3, vel: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3) {
  g.autodock = null;
  g.ship.mode = 'normal';
  resetFrame(g, frame);
  g.ship.pos.copy(pos);
  g.ship.vel.copy(vel);
  g.ship.q.setFromRotationMatrix(new THREE.Matrix4().lookAt(V(), fwd.clone().normalize(), up));
}

/** A circular orbit's velocity round `b` at `rel` (from its centre), prograde round `axis`. */
function orbitVel(b: Body, rel: THREE.Vector3, axis: THREE.Vector3) {
  const r = rel.length();
  const dir = V().crossVectors(axis, rel).normalize();
  return dir.multiplyScalar(Math.sqrt(b.mu / r));
}

/** A direction from `b`'s centre `a` rad from the point under the star, toward the axis `k`. */
function fromSunward(g: Game, b: Body, a: number) {
  const toS = g.cur.star.pos.clone().sub(b.pos).normalize();
  const side = V(0, 1, 0).cross(toS).normalize();
  return toS.multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a)).normalize();
}

/**
 * A daylit spot on `b` under thick cloud (sim/clouds.ts, the cloud cube's cover): the most clouded of
 * a few hundred directions within ~35° of the sunward one (a fixed spot kept landing in clear sky).
 * `low`: over low ground too (under the deck, not in it on a mountain).
 */
function cloudySpot(g: Game, b: World, low: boolean) {
  const c = fromSunward(g, b, 0.9);
  const u = V(0, 1, 0).cross(c).normalize(),
    w = V().crossVectors(c, u);
  let best = c,
    score = -Infinity;
  for (let i = 0; i < 300; i++) {
    // a sunflower spiral over the cap
    const r = 0.6 * Math.sqrt((i + 0.5) / 300),
      a = i * 2.39996;
    const d = c.clone().addScaledVector(u, r * Math.cos(a)).addScaledVector(w, r * Math.sin(a)).normalize();
    let s = cloudCoverAt(b, d);
    if (low) s -= Math.max(0, surfaceRadius(b, b.pos.clone().addScaledVector(d, b.radius)) - b.radius) / 1000;
    if (s > score) {
      score = s;
      best = d;
    }
  }
  return best;
}

export function debugSpots(g: Game): Spot[] {
  const out: Spot[] = [];
  const bodies = g.cur.bodies;
  const ringed = bodies.find((b): b is World => b.kind !== 'star' && !!b.ring);
  const clouded = bodies.find((b): b is World => b.kind !== 'star' && !!atmoOf(b) && (b.type === WT.EarthLike || b.type === WT.Ocean));
  const aired = clouded ?? bodies.find((b): b is World => b.kind !== 'star' && !!atmoOf(b));
  if (ringed?.ring) {
    const b = ringed,
      ring = b.ring!;
    const n = V(b.axis.x, b.axis.y, b.axis.z).normalize();
    out.push({
      id: 'belt',
      label: 'Ring belt',
      hint: `in ${b.name}'s rocks, orbiting with them`,
      go: () => {
        const toS = g.cur.star.pos.clone().sub(b.pos);
        toS.addScaledVector(n, -toS.dot(n)).normalize();
        const dir = toS.clone().multiplyScalar(0.5).addScaledVector(V().crossVectors(n, toS), 0.866).normalize();
        const rel = dir.clone().multiplyScalar((ring.inner + (ring.outer - ring.inner) * 0.4) * b.radius).addScaledVector(n, 40);
        const pos = b.pos.clone().add(rel);
        const away = pos.clone().sub(g.cur.star.pos).normalize();
        const fwd = away.clone().multiplyScalar(Math.cos(0.8)).addScaledVector(V().crossVectors(n, away).normalize(), Math.sin(0.8)).addScaledVector(n, -0.1);
        place(g, b, pos, orbitVel(b, rel.clone().addScaledVector(n, -40), n), fwd, n);
      },
    });
    out.push({
      id: 'ringshadow',
      label: 'Ring shadow',
      hint: `${b.name} from its sunward side`,
      go: () => {
        const toS = g.cur.star.pos.clone().sub(b.pos).normalize();
        const side = V().crossVectors(n, toS).normalize();
        const dir = toS.multiplyScalar(0.85).addScaledVector(side, 0.25).addScaledVector(n, -0.45).normalize();
        const pos = b.pos.clone().addScaledVector(dir, b.radius * 5);
        place(g, b, pos, V(), b.pos.clone().sub(pos), n);
      },
    });
  }
  if (clouded) {
    const b = clouded;
    const deck = (atmoOf(b)?.H ?? 8000) * 1.3;
    const over = (alt: number, pitch: number, low: boolean) => {
      const up = cloudySpot(g, b, low);
      const side = V(0, 1, 0).cross(g.cur.star.pos.clone().sub(b.pos).normalize()).normalize();
      const ground = Math.max(b.radius, surfaceRadius(b, b.pos.clone().addScaledVector(up, b.radius)));
      const pos = b.pos.clone().addScaledVector(up, ground + alt);
      const t = V().crossVectors(up, side).normalize();
      // moving with the ground (the air turns with the world): still, as far as the air's concerned
      const spin = V(b.axis.x, b.axis.y, b.axis.z).multiplyScalar(b.spin).cross(pos.clone().sub(b.pos));
      place(g, b, pos, spin, t.multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)), up);
    };
    out.push({ id: 'cloudsabove', label: 'Above the clouds', hint: `${b.name}, ${Math.round((deck * 1.6) / 1000)} km up`, go: () => over(deck * 1.6, -0.45, false) });
    out.push({ id: 'cloudsbelow', label: 'Under the clouds', hint: `${b.name}, 1.5 km over the ground`, go: () => over(1500, 0.3, true) });
  }
  if (aired) {
    const b = aired;
    out.push({
      id: 'reentry',
      label: 'Re-entry',
      hint: `75 km over ${b.name} at 7.6 km/s`,
      go: () => {
        const up = fromSunward(g, b, 0.9);
        const side = V(0, 1, 0).cross(g.cur.star.pos.clone().sub(b.pos).normalize()).normalize();
        const pos = b.pos.clone().addScaledVector(up, b.radius + 75e3);
        const fwd = V().crossVectors(up, side).normalize().addScaledVector(up, -0.05).normalize();
        place(g, b, pos, fwd.clone().multiplyScalar(7600), fwd, up);
      },
    });
  }
  for (const sky of [false, true]) {
    const st = g.cur.stations.find((s) => !!s.sky === sky);
    if (!st) continue;
    out.push({
      id: sky ? 'skystation' : 'station',
      label: sky ? 'Sky station' : 'Station',
      hint: st.name,
      go: () => {
        const q = stationQuat(st, g.simTime);
        const fz = V(0, 0, 1).applyQuaternion(q),
          fx = V(1, 0, 0).applyQuaternion(q),
          fy = V(0, 1, 0).applyQuaternion(q);
        const pos = sky
          ? st.pos.clone().addScaledVector(fz, st.size * 1.2).addScaledVector(fx, st.size * 2.5)
          : st.pos.clone().addScaledVector(fz, st.size * 3).addScaledVector(fx, st.size * 0.3).addScaledVector(fy, st.size * 0.2);
        place(g, st.parent, pos, V().subVectors(st.vel, st.parent.vel), st.pos.clone().sub(pos), sky ? fz : fy);
        g.target = st;
      },
    });
  }
  out.push({
    id: 'star',
    label: 'The star',
    hint: `${g.cur.star.name} from 1 AU`,
    go: () => {
      const s = g.cur.star;
      const pos = s.pos.clone().add(V(1.43e11, 2e10, 3e10));
      const d = s.pos.clone().sub(pos).normalize();
      const side = V(0, 1, 0).cross(d).normalize();
      place(g, s, pos, V(), d.multiplyScalar(Math.cos(0.3)).addScaledVector(side, Math.sin(0.3)), V(0, 1, 0));
    },
  });
  const wreck = wrecksHere(g)[0];
  if (wreck) {
    out.push({
      id: 'wreck',
      label: 'Wreck',
      hint: wreck.name,
      go: () => {
        const b = wreckBody(g, wreck) ?? g.cur.star;
        const pos = wreck.pos.clone().add(V(250, 60, 120));
        place(g, b, pos, V().subVectors(wreck.vel, b.vel), wreck.pos.clone().sub(pos), V(0, 1, 0));
        g.target = wreck;
      },
    });
  }
  out.push({
    id: 'space',
    label: 'Deep space',
    hint: '60 AU above the system',
    go: () => {
      const s = g.cur.star;
      place(g, s, s.pos.clone().add(V(0, 60 * 1.496e11, 0)), V(), V(1, 0.02, 0.3), V(0, 1, 0));
    },
  });
  return out;
}
