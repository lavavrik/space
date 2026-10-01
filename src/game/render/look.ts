/*
 * How things look, shared by the renderer (gpu/) and the overlay: constants and small helpers that
 * aren't about the GPU itself (they lived in the WebGL renderer, render/SceneRenderer.ts, before
 * docs/webgpu.md phase 7).
 */
import { WT } from '../constants';
import { THREE } from '../lib/three';
import { atmoOf } from '../sim/atmosphere';
import type { World } from '../types';

/** The cloud deck's height, in scale heights of the air. */
export const CLOUD_H = 1.3;

/**
 * Scattering coefficients at the ground (1/m, per colour) for the sky shader: Earth-like and ocean
 * worlds scatter like air (Rayleigh, ∝ λ⁻⁴: blue sky, red sunsets); the rest in their palette's sky
 * colour (dust, haze), thicker the denser the air.
 */
export function airBeta(b: World) {
  const a = atmoOf(b);
  if (!a) return new THREE.Vector3();
  const k = Math.min(a.rho0 / 1.2, 50); // (a 60 kg/m³ Venus-like air would be solid white otherwise)
  if (b.type === WT.EarthLike || b.type === WT.Ocean) return new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6).multiplyScalar(k);
  const c = b.pal.atmo!.c;
  const m = Math.max(c.r, c.g, c.b, 1e-3);
  // (a giant's face is its cloud tops: at full strength the haze above them washed an ice giant out
  // to white, its bands and storms gone)
  const giant = b.type === WT.GasGiant || b.type === WT.IceGiant ? 0.3 : 1;
  // (a Titan's air is thick with orange smog, methane broken up by sunlight: from orbit it hides the
  // ground. As thin as a desert's dust haze, the white ice showed through plainly; at 6× the ground
  // under it was near black, the single scattering here missing the light that really gets down)
  // Its scattering is near grey: the colour is its absorption's (atmo.wgsl atExt, world.smog), which
  // takes out the blue. Scattering orange as well, the red was scattered out of the light on its way
  // down, and the sky deep in it was olive.
  const smog = b.type === WT.Icy ? 3 : 1;
  const grey = b.type === WT.Icy ? 0.7 : 0;
  const col = (x: number) => (x / m) * (1 - grey) + grey;
  return new THREE.Vector3(col(c.r), col(c.g), col(c.b)).multiplyScalar(1.5e-5 * Math.sqrt(k) * giant * smog);
}

/** Apparent radius (px) above which a world with relief is drawn as LOD terrain instead of a sphere. */
export const TERRAIN_PX = 200;
/** …and only within this many radii of its centre (without the periscope it turns on at ~7). */
export const TERRAIN_NEAR = 10;
/** Most pixels the 3D view renders per frame (≈ 2980×1680): up to 1.5× the CSS resolution, but a 4K screen would render 8+ megapixels for little visible gain. */
export const MAX_RENDER_PIXELS = 5e6;
/** Vertices in the orbit preview ring (spaced densely near the ship). */
export const RING_N = 720;
export const RING_PLAN = new THREE.Color(1, 0.65, 0.23); // amber while planning
export const RING_AP = new THREE.Color(0.5, 0.86, 1); // cyan once the autopilot flies it
/** Colour of a distant station's beacon dot (and its overlay marker): mint, unlike any body. */
export const STATION_RGB = new THREE.Color(0.45, 1, 0.7);
/** Dust grains round the ship, in a wrapping box this big (m). */
export const DUST = 700,
  DUSTBOX = 3000;
/**
 * Dust fades out between these speeds (m/s): by 10 km/s the 3 km box is crossed several times a
 * second and the grains, re-scattered each time, read as flickering static.
 */
export const DUST_FADE_FROM = 3e3,
  DUST_FADE_TO = 10e3;
