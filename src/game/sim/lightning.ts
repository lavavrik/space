/**
 * Lightning strikes near you under a storm (docs/clouds.md "Storms"). The clouds' own flashes
 * (clouds.wgsl flashAt) are worked out per pixel on the GPU, where nothing else can see them; the
 * strikes here are the ones the game knows about, so a bolt can be drawn to the ground, light the
 * ground and the clouds round it, flash the whole view, and be heard (thunder, after the sound's
 * delay: audio/ShipAudio.ts).
 *
 * Under storm cover (the cover overhead over 90 % of the most the world has: sim/clouds.ts), below
 * the clouds' top, a strike every 3–12 s somewhere 1.5–20 km off, where the cover is that thick too.
 * Each lasts LIFE s: a few return strokes, flickering (`strikeGlow`). Visual and sound only.
 */
import { THREE } from '../lib/three';
import type { Game } from '../Game';
import { WT } from '../constants';
import { atmoOf } from './atmosphere';
import { cloudCoverAt } from './clouds';
import { surfaceRadius } from './terrain';
import { CLOUD_H } from '../render/look';
import { mulberry32 } from '../lib/rng';

export interface Strike {
  /** Where it hits the ground, and where it leaves the cloud base (world, m). */
  ground: THREE.Vector3;
  top: THREE.Vector3;
  /** When it struck (sim time, s). */
  t0: number;
  /** Its shape's seed. */
  seed: number;
}

/** How long a strike lasts (s). */
export const LIFE = 0.6;
/** Return strokes: when each starts (s after the strike) and how bright it is. */
const STROKES: [number, number][] = [
  [0, 1],
  [0.09, 0.7],
  [0.22, 0.85],
  [0.38, 0.45],
];

/** How bright a strike is `age` s in (0…~1): each stroke a sharp peak decaying in ~40 ms. */
export function strikeGlow(age: number): number {
  if (age < 0 || age > LIFE) return 0;
  let k = 0;
  for (const [t, a] of STROKES) if (age >= t) k = Math.max(k, a * Math.exp(-(age - t) / 0.04));
  return k;
}

export class Lightning {
  strikes: Strike[] = [];
  private next = 0;

  update(g: Game) {
    const now = g.simTime;
    this.strikes = this.strikes.filter((s) => now - s.t0 < LIFE);
    const b = g.frameBody;
    if (b.kind === 'star' || (b.type !== WT.EarthLike && b.type !== WT.Ocean) || g.inStation) return;
    const air = atmoOf(b);
    if (!air) return;
    const up = g.ship.pos.clone().sub(b.pos);
    const alt = up.length() - b.radius;
    up.normalize();
    const deckH = air.H * CLOUD_H;
    if (alt > deckH * 1.05) return;
    const most = b.type === WT.Ocean ? 0.95 : 0.85;
    if (cloudCoverAt(b, up, now) / most < 0.9) return;
    if (this.next === 0 || this.next < now - 60) this.next = now + 1 + Math.random() * 4;
    if (now < this.next) return;
    this.next = now + 3 + Math.random() * 9;
    // somewhere 1.5–20 km off, under storm cover too
    const east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
    east.normalize();
    const north = up.clone().cross(east);
    for (let tries = 0; tries < 6; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = 1500 + Math.random() * 18500;
      const dir = up
        .clone()
        .addScaledVector(east, (Math.cos(a) * d) / b.radius)
        .addScaledVector(north, (Math.sin(a) * d) / b.radius)
        .normalize();
      if (cloudCoverAt(b, dir, now) / most < 0.85) continue;
      const ground = b.pos.clone().addScaledVector(dir, surfaceRadius(b, b.pos.clone().addScaledVector(dir, b.radius)));
      const top = b.pos.clone().addScaledVector(dir, b.radius + deckH * 0.45);
      this.strikes.push({ ground, top, t0: now, seed: Math.random() * 1000 });
      return;
    }
  }
}

/** Points in a bolt's shape at most (tonemap.wgsl Post.boltP). */
export const BOLT_POINTS = 48;

/**
 * A strike's shape (world, m): the main channel from the cloud base to the ground in 22 jagged
 * steps (each turning off by up to ~0.45 of its length, the deviation pulled back toward the
 * straight line so it doesn't wander off), and two or three branches forking off its upper half,
 * fading out before the ground. Each point: where it is, and whether it starts a new strand.
 */
export function boltPath(s: Strike): { p: THREE.Vector3; start: boolean }[] {
  const r = mulberry32(Math.floor(s.seed * 1e3));
  const axis = s.ground.clone().sub(s.top);
  const len = axis.length();
  const down = axis.clone().divideScalar(len);
  const a = new THREE.Vector3(1, 0, 0).cross(down);
  if (a.lengthSq() < 1e-6) a.set(0, 0, 1).cross(down);
  a.normalize();
  const b = down.clone().cross(a);
  const out: { p: THREE.Vector3; start: boolean }[] = [];
  const N = 22;
  const step = len / N;
  const main: THREE.Vector3[] = [];
  let ox = 0,
    oy = 0;
  for (let i = 0; i <= N; i++) {
    const p = s.top.clone().addScaledVector(down, i * step).addScaledVector(a, ox).addScaledVector(b, oy);
    main.push(p);
    out.push({ p, start: i === 0 });
    ox = ox * 0.85 + (r() - 0.5) * step * 0.9;
    oy = oy * 0.85 + (r() - 0.5) * step * 0.9;
    if (i === N - 1) ox = oy = 0; // (it ends where it strikes)
  }
  const branches = 2 + Math.floor(r() * 2);
  for (let k = 0; k < branches && out.length < BOLT_POINTS - 8; k++) {
    let p = main[2 + Math.floor(r() * (N / 2 - 2))].clone();
    out.push({ p, start: true });
    const dir = down.clone().addScaledVector(a, (r() - 0.5) * 1.6).addScaledVector(b, (r() - 0.5) * 1.6).normalize();
    for (let i = 0; i < 6; i++) {
      p = p.clone().addScaledVector(dir, step * (0.8 + r() * 0.6)).addScaledVector(a, (r() - 0.5) * step * 0.8).addScaledVector(b, (r() - 0.5) * step * 0.8);
      out.push({ p, start: false });
    }
  }
  return out;
}
