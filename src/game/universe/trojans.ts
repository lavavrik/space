import { WT } from '../constants';
import { mulberry32, rr } from '../lib/rng';
import type { Body, StarSystem, TrojanField, World } from '../types';

export type { TrojanField };

/*
 * Trojan swarms and the depots parked at Lagrange points (docs/lagrange.md). A swarm is a loose
 * cloud of rocks round a planet's L4 or L5, thick at its core and thinning out; every gas and ice
 * giant has both, a rocky planet sometimes a thin one. A depot is a station parked at L4 or L5
 * (universe/stations.ts buildDepots): at a giant's swarm about one time in five, and now and then
 * beside a habitable world. From their own RNG stream, drawing the same number of values for each
 * planet, so adding them changed nothing that was there.
 */

export interface DepotSite {
  planet: World;
  k: 4 | 5;
  /** How far off the point, in mean anomaly (rad): it's parked somewhere in the swarm, not at its exact middle. */
  dM: number;
  field?: TrojanField;
}

const isGiant = (b: World) => b.type >= WT.GasGiant;

export function buildTrojans(sys: StarSystem, bodies: Body[]): { fields: TrojanField[]; sites: DepotSite[] } {
  const g = mulberry32(sys.seed ^ 0x7120a45);
  const fields: TrojanField[] = [];
  const sites: DepotSite[] = [];
  for (const b of bodies) {
    if (b.kind !== 'planet') continue;
    // (the same draws for every planet, whatever they decide)
    const rollField = g(),
      pickK = g(),
      sg = mulberry32(Math.floor(g() * 2 ** 32));
    const rollDepot = [g(), g()],
      pickDepotK = g(),
      dMs = [rr(g, -0.5, 0.5), rr(g, -0.5, 0.5)];
    const a = b.orb.a;
    const giant = isGiant(b);
    const make = (k: 4 | 5, small: boolean): TrojanField => {
      const f: TrojanField = {
        id: `${b.name}#L${k}`,
        name: `${b.name} L${k} trojans`,
        planet: b,
        k,
        seed: Math.floor(sg() * 2 ** 31),
        sigA: small ? rr(sg, 0.05, 0.09) : rr(sg, 0.14, 0.22),
        sigR: a * (small ? rr(sg, 0.008, 0.02) : rr(sg, 0.02, 0.045)),
        sigZ: a * (small ? rr(sg, 0.006, 0.015) : rr(sg, 0.015, 0.04)),
        core: small ? rr(sg, 0.03, 0.07) : rr(sg, 0.1, 0.18),
      };
      fields.push(f);
      return f;
    };
    const have: TrojanField[] = [];
    if (giant) {
      have.push(make(4, false), make(5, false));
      // a depot at either swarm, about one time in five each
      have.forEach((f, i) => {
        if (rollDepot[i] < 0.18) sites.push({ planet: b, k: f.k, dM: dMs[i] * f.sigA, field: f });
      });
    } else {
      if (rollField < 0.2) have.push(make(pickK < 0.5 ? 4 : 5, true));
      const hab = b.type === WT.EarthLike || b.type === WT.Ocean;
      if (hab && rollDepot[0] < 0.15) {
        const k: 4 | 5 = pickDepotK < 0.5 ? 4 : 5;
        sites.push({ planet: b, k, dM: dMs[0] * 0.06, field: have.find((f) => f.k === k) });
      }
    }
  }
  return { fields, sites };
}
