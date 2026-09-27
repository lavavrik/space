/*
 * Exposure for artificial light. The shaders are calibrated so a sunlit surface reads ~0.55 whatever
 * the star (the "eye" is adapted to sunlight). Lamps are physical:
 *   - the ship's headlight, HEAD_CD candela: a 5 kW LED floodlight (~500,000 lm) in a ~20° cone;
 *   - station floodlights, FLOOD_LUX on the hull.
 * Next to sunlight (SUN_LUX) they're nothing: 130 lux at 100 m is 1/800 of daylight. In the dark the
 * eye adapts: here the exposure gain follows the brightest light on the station you're looking at,
 * if it's in shadow, and maps it to KEY (a dim-but-clear level), easing over ~1.5 s like eyes do.
 * Inside a hangar its lamps (HANGAR_LUX ≙ 1.0 in the interior shader) set the level.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';

export const HEAD_CD = 1.3e6;
const FLOOD_LUX = 30,
  SUN_LUX = 1e5,
  HANGAR_LUX = 500;
/** Where an adapted dark scene lands, relative to a sunlit one (0.55). */
const KEY = 0.4;
/** How fast the adaptation eases (1/s, in log space). */
const ADAPT = 1.5;
/** Sunlit brightness in the hull shader. */
const SUNLIT = 0.55;

export class Exposure {
  /** Gain on artificial light, 1 = adapted to sunlight. */
  gain = 1;
  private last = 0;

  /** Work out the target gain from what the ship is looking at, and ease toward it. */
  update(g: Game, litOf: (st: Game['cur']['stations'][number]) => boolean) {
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.2, now - this.last) : 0;
    this.last = now;
    let target = 1;
    if (!g.inStation) {
      // the nearest station roughly ahead (within ~30°) and within 10 km, if it's in shadow
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(g.ship.q);
      let best: { d: number; lit: boolean } | null = null;
      for (const st of g.cur.stations) {
        const rel = st.pos.clone().sub(g.ship.pos);
        const d = rel.length();
        if (d > 10e3 || rel.dot(fwd) < d * 0.85) continue;
        if (!best || d < best.d) best = { d, lit: litOf(st) };
      }
      if (best && !best.lit) {
        const surf = Math.max(20, best.d - 600);
        const eKey = Math.max(FLOOD_LUX, g.lights ? HEAD_CD / (surf * surf) : 0);
        target = Math.min(1e5, Math.max(1, (KEY / SUNLIT) * (SUN_LUX / eKey)));
      }
    }
    const k = Math.min(1, ADAPT * dt);
    this.gain = Math.exp(Math.log(this.gain) + (Math.log(target) - Math.log(this.gain)) * k);
  }

  /** Headlight constant for the hull shader: candela → brightness (÷ d² in the shader). */
  get headK() {
    return (HEAD_CD * SUNLIT * this.gain) / SUN_LUX;
  }
  /** Floodlight brightness on the hull. */
  get floodK() {
    return (FLOOD_LUX * SUNLIT * this.gain) / SUN_LUX;
  }
  /** Headlight constant inside a hangar, against its lamps. */
  static readonly headKi = HEAD_CD / HANGAR_LUX;
}
