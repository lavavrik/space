import { GALAXY_SEED, SYSTEM_COUNT } from '../constants';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { StarSystem } from '../types';
import { makeName } from './names';
import { makeStar } from './stars';
import { buildSystem, findHome } from './system';

function generateGalaxy(): StarSystem[] {
  const systems: StarSystem[] = [];
  const usedNames = new Set<string>();
  const g = mulberry32(GALAXY_SEED);
  for (let i = 0; i < SYSTEM_COUNT; i++) {
    const seed = Math.floor(g() * 1e9);
    const pos = i === 0 ? new THREE.Vector3() : new THREE.Vector3(rr(g, -60, 60), rr(g, -9, 9), rr(g, -60, 60));
    const sr = mulberry32(seed);
    const name = makeName(sr, usedNames),
      star = makeStar(sr, i === 0);
    const sys: StarSystem = { id: i, seed, pos, name, star };
    if (i === 0) {
      // the home system must hold an Earth-like world with a moon
      for (let k = 0; k < 400; k++) {
        if (findHome(buildSystem(sys))) break;
        sys.seed = seed + k + 1;
      }
    }
    systems.push(sys);
  }
  return systems;
}

let cache: StarSystem[] | null = null;

/** All star systems, generated once from the galaxy seed. System 0 is home. */
export function getGalaxy() {
  return (cache ??= generateGalaxy());
}
