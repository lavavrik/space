import { describe, expect, it } from 'vitest';
import { AU, GRAV } from '../constants';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import { gravityAt, dominantBody } from '../sim/gravity';
import { updateBodies } from '../sim/kepler';
import type { CurrentSystem, Star, StarSystem, World } from '../types';
import { makeCompanion, pairSpec } from '../universe/binary';
import { homeSystem } from '../universe/galaxy';
import { CLASSES, makeStar } from '../universe/stars';
import { buildSystem, findHome, systemAnchor } from '../universe/system';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** A system with this primary class and companion, for building. */
function sysWith(seed: number, companion: StarSystem['companion'], cls = 'G'): StarSystem {
  const g = mulberry32(seed);
  let star = makeStar(g, true);
  while (star.cls !== cls) star = makeStar(g, false);
  return { id: `t:${seed}`, seed, pos: V(), name: 'Testa', star, companion };
}
function cur(bodies: ReturnType<typeof buildSystem>, sys: StarSystem): CurrentSystem {
  const stars = bodies.filter((b): b is Star => b.kind === 'star');
  return { sys, bodies, star: stars[0], stars, anchor: systemAnchor(bodies), close: !!sys.companion?.close, stations: [] };
}
/** The first seed from 1 whose companion is close (or wide). */
function pairSys(close: boolean) {
  for (let s = 1; ; s++) {
    const probe = sysWith(s, undefined);
    const c = makeCompanion(probe.star, s);
    if (c && c.close === close) return { ...probe, companion: c };
  }
}

describe('binary stars: generation', () => {
  it('pairs up stars by class, about 35 % of them close, in the separations set', () => {
    const want: Record<string, number> = { M: 0.25, K: 0.4, G: 0.45, F: 0.5 };
    let close = 0,
      pairs = 0;
    for (const cls of Object.keys(want)) {
      const c = CLASSES.find((x) => x[0] === cls)!;
      const primary = { cls, spec: cls + '5 V', T: (c[3][0] + c[3][1]) / 2, R: 1, L: 1, color: new THREE.Color() };
      let n = 0;
      const N = 20000;
      for (let s = 0; s < N; s++) {
        const k = makeCompanion(primary, s * 7919 + 13);
        if (!k) continue;
        n++;
        pairs++;
        if (k.close) {
          close++;
          expect(k.a).toBeGreaterThanOrEqual(0.03);
          expect(k.a).toBeLessThanOrEqual(0.4);
          expect(k.e).toBeLessThan(0.1);
        } else {
          expect(k.a).toBeGreaterThanOrEqual(20);
          expect(k.a).toBeLessThanOrEqual(400);
          expect(k.e).toBeLessThan(0.4);
        }
        expect(k.star.L).toBeLessThanOrEqual(primary.L * 1.001);
      }
      expect(Math.abs(n / N - want[cls])).toBeLessThan(0.03);
    }
    expect(Math.abs(close / pairs - 0.35)).toBeLessThan(0.03);
  });

  it('makes Venydes a close G + K pair, with an Earth-like start world', () => {
    const home = homeSystem();
    expect(home.companion).toMatchObject({ a: 0.15, e: 0.03, close: true });
    expect(pairSpec(home)).toMatch(/^G\d V \+ K\d V$/);
    expect(findHome(buildSystem(home))).toBeTruthy();
  });
});

describe('binary stars: orbits', () => {
  for (const close of [true, false]) {
    it(`keeps a ${close ? 'close' : 'wide'} pair's barycentre at the origin, at the right period`, () => {
      const sys = pairSys(close);
      const bodies = buildSystem(sys);
      const [A, B] = bodies as Star[];
      expect(A.parent).toBe(B.parent);
      const bary = systemAnchor(bodies);
      expect(bary.bary).toBe(true);
      const a = sys.companion!.a * AU,
        e = sys.companion!.e;
      const P = 2 * Math.PI * Math.sqrt(a ** 3 / (GRAV * (A.mass + B.mass)));
      for (const t of [0, P * 0.137, P * 0.5, 3.3 * P]) {
        updateBodies(bodies, t);
        const cm = A.pos.clone().multiplyScalar(A.mass).addScaledVector(B.pos, B.mass).divideScalar(A.mass + B.mass);
        expect(cm.length() / a).toBeLessThan(1e-9);
        const sep = A.pos.distanceTo(B.pos);
        expect(sep).toBeGreaterThanOrEqual(a * (1 - e) * (1 - 1e-9));
        expect(sep).toBeLessThanOrEqual(a * (1 + e) * (1 + 1e-9));
      }
      // a whole period later, back where it was
      updateBodies(bodies, 0);
      const p0 = A.pos.clone();
      updateBodies(bodies, P);
      expect(A.pos.distanceTo(p0) / a).toBeLessThan(1e-6);
    });
  }

  it("puts a close pair's planets round both, well outside the pair", () => {
    const sys = pairSys(true);
    const bodies = buildSystem(sys);
    const bary = systemAnchor(bodies);
    const planets = bodies.filter((b): b is World => b.kind === 'planet');
    expect(planets.length).toBeGreaterThan(0);
    for (const p of planets) {
      expect(p.parent).toBe(bary);
      expect(p.orbit).toBeGreaterThanOrEqual(3.5 * sys.companion!.a * AU * (1 - 1e-9));
    }
  });

  it("gives each star of a wide pair its own planets, within 0.3 of the closest approach", () => {
    const sys = pairSys(false);
    const bodies = buildSystem(sys);
    const [A, B] = bodies as Star[];
    const lim = 0.3 * sys.companion!.a * AU * (1 - sys.companion!.e);
    const planets = bodies.filter((b): b is World => b.kind === 'planet');
    for (const p of planets) {
      expect([A, B]).toContain(p.parent);
      expect(p.orbit).toBeLessThanOrEqual(lim);
      if (p.parent === B) expect(p.name.startsWith(`${sys.name} B `)).toBe(true);
    }
    expect(new Set(bodies.map((b) => b.name)).size).toBe(bodies.length);
  });

  it('builds a lone star exactly as before a companion existed', () => {
    const sys = sysWith(42, undefined);
    const bodies = buildSystem(sys);
    expect(bodies.filter((b) => b.kind === 'star')).toHaveLength(1);
    expect(systemAnchor(bodies)).toBe(bodies[0]);
    expect(bodies[0].pos.length()).toBe(0);
  });
});

describe('binary stars: gravity', () => {
  it("sums a close pair's stars outside the planets", () => {
    const sys = pairSys(true);
    const bodies = buildSystem(sys);
    updateBodies(bodies, 12345);
    const c = cur(bodies, sys);
    const p = V(0.02 * AU, 0.01 * AU, 2 * AU); // (off the plane, well away from any planet's SOI at this time)
    const gr = gravityAt(c, p);
    expect(gr.body).toBe(c.anchor);
    const want = V();
    for (const s of c.stars) {
      const d = s.pos.clone().sub(p);
      want.addScaledVector(d, s.mu / d.length() ** 3);
    }
    expect(gr.vec.distanceTo(want) / want.length()).toBeLessThan(1e-12);
  });

  it("nests a wide pair's stars inside the barycentre by their Roche lobes", () => {
    const sys = pairSys(false);
    const bodies = buildSystem(sys);
    const c = cur(bodies, sys);
    const [, B] = c.stars;
    const g = mulberry32(3);
    // a point inside B's lobe but clear of its planets' SOIs; and one far outside both
    let inside = B.pos.clone().add(V(0, B.soi * 0.8, 0));
    for (let k = 0; k < 50 && dominantBody(c, inside) !== B; k++) inside = B.pos.clone().add(V(rr(g, -1, 1), rr(g, -1, 1), rr(g, -1, 1)).setLength(B.soi * 0.8));
    expect(dominantBody(c, inside)).toBe(B);
    expect(dominantBody(c, V(0, 1e4 * AU, 0))).toBe(c.anchor);
  });
});
