/**
 * Dev-only camera poses for checking how things look (in the console as `farlightPose`; wired in
 * ui/hooks/useGame.ts under `import.meta.env.DEV`). Each pauses the game and puts the ship somewhere
 * telling: `ring()` inside the nearest ringed world's belt looking away from the star (rocks lit and
 * shadowing each other), `station()` in front of a station's slot, `surface(name, alt)` above a
 * world's day side looking along the ground, `space()` far above the system with nothing near.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { stationQuat } from '../sim/stationGeom';
import type { World } from '../types';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

function look(g: Game, eye: THREE.Vector3, fwd: THREE.Vector3, up: THREE.Vector3) {
  g.paused = true;
  g.ship.pos.copy(eye);
  g.ship.q.setFromRotationMatrix(new THREE.Matrix4().lookAt(V(), fwd, up));
}

export function poses(g: Game) {
  return {
    /** In the belt, `h` m above the ring plane, `t` of the way out, turned `yaw` rad from looking straight away from the star. */
    ring(h = 60, t = 0.4, yaw = 0.5, pitch = -0.1) {
      const b = g.cur.bodies.find((x): x is World => x.kind !== 'star' && !!x.ring);
      if (!b?.ring) return 'no ringed world here';
      const n = V(b.axis.x, b.axis.y, b.axis.z).normalize();
      const toS = g.cur.star.pos.clone().sub(b.pos);
      toS.addScaledVector(n, -toS.dot(n)).normalize();
      const dir = toS.clone().multiplyScalar(0.5).addScaledVector(V().crossVectors(n, toS), 0.866).normalize();
      const eye = b.pos.clone().addScaledVector(dir, (b.ring.inner + (b.ring.outer - b.ring.inner) * t) * b.radius).addScaledVector(n, h);
      const away = eye.clone().sub(g.cur.star.pos).normalize();
      const fwd = away.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(V().crossVectors(n, away).normalize(), Math.sin(yaw));
      look(g, eye, fwd.addScaledVector(n, Math.sin(pitch)).normalize(), n);
      return b.name;
    },
    /** `k` station sizes in front of the first (orbital or sky) station's slot, a little off its axis. */
    station(k = 3, sky = false) {
      const st = g.cur.stations.find((s) => !!s.sky === sky) ?? g.cur.stations[0];
      if (!st) return 'no station here';
      const q = stationQuat(st, g.simTime);
      const fz = V(0, 0, 1).applyQuaternion(q),
        fx = V(1, 0, 0).applyQuaternion(q),
        fy = V(0, 1, 0).applyQuaternion(q);
      const eye = st.pos.clone().addScaledVector(fz, st.size * k).addScaledVector(fx, st.size * 0.3).addScaledVector(fy, st.size * 0.2);
      look(g, eye, st.pos.clone().sub(eye).normalize(), fy);
      return st.name;
    },
    /** `alt` m above world `name`'s day side, looking along the ground. */
    surface(name: string, alt = 4000, pitch = -0.2) {
      const b = g.cur.bodies.find((x) => x.name === name);
      if (!b) return 'no such body';
      const toS = g.cur.star.pos.clone().sub(b.pos).normalize();
      const side = V(0, 1, 0).cross(toS).normalize();
      const up = toS.clone().multiplyScalar(Math.cos(1)).addScaledVector(side, Math.sin(1)).normalize();
      const t = V().crossVectors(up, side).normalize();
      look(g, b.pos.clone().addScaledVector(up, b.radius + alt), t.multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch)).normalize(), up);
      return b.name;
    },
    /** 60 AU above the star, nothing near. */
    space() {
      look(g, g.cur.star.pos.clone().add(V(0, 60 * 1.496e11, 0)), V(1, 0.02, 0.3).normalize(), V(0, 1, 0));
      return 'ok';
    },
  };
}
