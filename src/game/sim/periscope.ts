/*
 * Periscope (Z): a narrow-field view that zooms the whole scene, 2× to 1,000× (the mouse wheel sets
 * it while it's up; 100× to start). It's a real narrower field of view, not a scaled image: planets
 * pick their detailed meshes, markers and picking follow (Game.view.pxPerRad), and steering slows
 * down by the magnification so you can hold a target in the middle. The zoom eases in and out.
 */
import { FOV } from '../constants';
import type { Game } from '../Game';

export const ZOOM_MIN = 2,
  ZOOM_MAX = 1000,
  ZOOM_START = 100;
/** How fast the view eases to the new magnification (1/s, in log space). */
const EASE = 7;

export function togglePeriscope(g: Game) {
  const z = g.zoom;
  z.on = !z.on;
  g.showMsg(z.on ? `Periscope ${z.mag}× · wheel changes magnification · Z lowers it` : 'Periscope down');
}

/** Wheel while the periscope is up: 25% per notch. */
export function wheelZoom(g: Game, deltaY: number) {
  const z = g.zoom;
  z.mag = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z.mag * (deltaY < 0 ? 1.25 : 1 / 1.25))));
}

/** Ease the current magnification toward its target (real time) and update the view. */
export function updatePeriscope(g: Game, realDt: number) {
  const z = g.zoom;
  const target = z.on ? z.mag : 1;
  const k = Math.min(1, EASE * realDt);
  z.cur = Math.exp(Math.log(z.cur) + (Math.log(target) - Math.log(z.cur)) * k);
  if (Math.abs(z.cur / target - 1) < 0.002) z.cur = target;
  g.fov = (2 * Math.atan(Math.tan((FOV * Math.PI) / 360) / z.cur) * 180) / Math.PI;
  g.view.pxPerRad = g.view.H / 2 / Math.tan((g.fov * Math.PI) / 360);
}
