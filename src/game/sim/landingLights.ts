/**
 * Landing lights: two floodlights under the hull, angled a little forward (gpu/shaders/frame.wgsl
 * shipLights), switched by the ship itself. On low over a world (under LAND_ALT above the ground)
 * when it's dark there: night, or under thick cloud (sim/clouds.ts). Off again when it's light or
 * you climb, with a margin both ways so they don't flicker at the edge.
 */
import type { Game } from '../Game';
import { WT } from '../constants';
import { CLOUD_H } from '../render/look';
import { atmoOf } from './atmosphere';
import { cloudCoverAt } from './clouds';
import { altitudeAt } from './terrain';

/** On under this height over the ground (m), off again 15 % above it. */
export const LAND_ALT = 2000;
/** Power they draw (kW). */
export const LAND_KW = 1.2;

/** How dark it is at the ship, 0 (day) … 1 (night, or overcast overhead). */
function darkness(g: Game) {
  const b = g.frameBody;
  const up = g.ship.pos.clone().sub(b.pos).normalize();
  // (a pair: the higher of the two, docs/binaries.md)
  const sunEl = Math.max(...g.cur.stars.map((s) => Math.asin(Math.min(1, Math.max(-1, up.dot(s.pos.clone().sub(g.ship.pos).normalize()))))));
  // (the sun ~5° under the horizon: dark)
  let dark = 1 - Math.min(1, Math.max(0, (sunEl + 0.08) / 0.16));
  const air = b.kind !== 'star' ? atmoOf(b) : null;
  if (air && b.kind !== 'star' && (b.type === WT.EarthLike || b.type === WT.Ocean)) {
    // under the clouds (below the deck's top), thick cover overhead is as good as dusk
    const alt = g.ship.pos.distanceTo(b.pos) - b.radius;
    if (alt < air.H * CLOUD_H * 1.05) dark = Math.max(dark, Math.min(1, Math.max(0, (cloudCoverAt(b, up, g.simTime) - 0.5) / 0.3)));
  }
  return dark;
}

/** Each frame (sim/update.ts): switch them as the ship would. */
export function updateLandingLights(g: Game) {
  const b = g.frameBody;
  let want = false;
  if (b.kind !== 'star' && g.ship.mode === 'normal' && !g.inStation) {
    const on = g.landingLights;
    const agl = altitudeAt(b, g.ship.pos);
    if (agl < LAND_ALT * (on ? 1.15 : 1)) want = darkness(g) > (on ? 0.4 : 0.6);
  }
  if (want !== g.landingLights) {
    g.landingLights = want;
    g.showMsg(want ? 'Landing lights on' : 'Landing lights off');
  }
}
