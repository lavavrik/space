import { describe, expect, it } from 'vitest';
import { JUMP_RANGE, jumpCost } from '../constants';
import { THREE } from '../lib/three';
import { searchPath } from '../sim/navroute';
import { homeSystem, systemsNear } from '../universe/galaxy';

const home = homeSystem();
const far = systemsNear(new THREE.Vector3(), 95)
  .filter((s) => s.pos.length() > 80)
  .sort((a, b) => b.pos.length() - a.pos.length())
  .slice(0, 4);

const hops = (path: ReturnType<typeof searchPath>) => {
  let at = home;
  return path!.map((s) => {
    const ly = s.pos.distanceTo(at.pos);
    at = s;
    return ly;
  });
};

describe('navigation route search', () => {
  it('finds a chain of jumps within range that ends at the destination', () => {
    for (const dest of far) {
      const path = searchPath(home, dest, 'exotic');
      expect(path).not.toBeNull();
      expect(path![path!.length - 1].id).toBe(dest.id);
      for (const ly of hops(path)) expect(ly).toBeLessThanOrEqual(JUMP_RANGE);
    }
  });

  it('optimises for its mode: fewest jumps has the fewest hops, least exotic the least exotic', () => {
    for (const dest of far) {
      const byJumps = searchPath(home, dest, 'jumps')!,
        byExotic = searchPath(home, dest, 'exotic')!,
        byTime = searchPath(home, dest, 'fastest')!;
      const exotic = (p: typeof byJumps) => hops(p).reduce((t, ly) => t + jumpCost(ly), 0);
      expect(byJumps.length).toBeLessThanOrEqual(byExotic.length);
      expect(byJumps.length).toBeLessThanOrEqual(byTime.length);
      expect(exotic(byExotic)).toBeLessThanOrEqual(exotic(byJumps) + 1e-9);
      expect(exotic(byExotic)).toBeLessThanOrEqual(exotic(byTime) + 1e-9);
      // can't do better than ⌈distance / range⌉ jumps
      expect(byJumps.length).toBeGreaterThanOrEqual(Math.ceil(dest.pos.length() / JUMP_RANGE));
    }
  });
});
