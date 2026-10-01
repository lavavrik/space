/**
 * What a world's clouds are made of (docs/clouds.md "Kinds"), shared by the renderer (the cloud
 * cube, the volumetric clouds, the flat deck: world.wgsl World.cloudC) and the sim (the cover under
 * you, sim/clouds.ts; exposure; the debug jumps):
 *   - water (Earth-like and ocean worlds): white cloud, cumulus to storms, cirrus over it;
 *   - dust (desert worlds with air): dust storms, regional walls of the ground's own colour, from the
 *     ground up, soft and thin (visibility of a km or so, not a few hundred metres), most of the
 *     world clear between them (Mars);
 *   - acid (volcanic worlds with thick air, Venus): a deck of sulphuric-acid droplets high up (~3–4.4
 *     scale heights, 45–70 km on Venus), unbroken over the whole world, pale yellow; under it a dim
 *     orange day.
 */
import { WT } from '../constants';
import { THREE } from '../lib/three';
import type { Body, World } from '../types';
import { atmoOf } from './atmosphere';

/** The kinds (World.cloudC.w; clouds.wgsl cloudKind). */
export const CK = { Water: 0, Dust: 1, Acid: 2 } as const;
export type CloudKindId = (typeof CK)[keyof typeof CK];

export interface CloudKind {
  kind: CloudKindId;
  /** The deck's height (its top's, ~), in scale heights of the air. */
  h: number;
  /** The particles' colour (albedo, ≤ 1): water cloud's white, dust the ground's sand. */
  color: THREE.Color;
}

const cache = new WeakMap<World, CloudKind | null>();

/** A world's clouds, if it has any. */
export function cloudKindOf(b: Body): CloudKind | null {
  if (b.kind === 'star' || !atmoOf(b)) return null;
  let k = cache.get(b);
  if (k === undefined) {
    if (b.type === WT.EarthLike || b.type === WT.Ocean) k = { kind: CK.Water, h: 1.3, color: new THREE.Color(1, 1, 1) };
    // (the lighter sand, a little paler: fine dust in the air is paler than the ground it came from)
    else if (b.type === WT.Desert) k = { kind: CK.Dust, h: 0.9, color: b.pal.b.clone().lerp(new THREE.Color(1, 1, 1), 0.12) };
    // (the thick-aired ones only: a thin sulphur-dioxide haze over an Io has no deck)
    else if (b.type === WT.Volcanic && atmoOf(b)!.P0 > 5e5) k = { kind: CK.Acid, h: 4.2, color: new THREE.Color(1, 0.9, 0.66) };
    else k = null;
    cache.set(b, k);
  }
  return k;
}

/**
 * The deck's height (m) over a world's mean radius; 0 without clouds. At most 1.5 % of the radius
 * (Venus's is 1.2 %): small hot worlds' air has scale heights of 100+ km, and their acid deck was
 * hundreds of km up, a shell round them as wide as they are.
 */
export function deckHeight(b: Body): number {
  const k = cloudKindOf(b);
  return k ? Math.min(atmoOf(b)!.H * k.h, b.radius * 0.015) : 0;
}
