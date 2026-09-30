/**
 * What the game needs from its renderer (gpu/GpuRenderer.ts; docs/webgpu.md): the overlay and the
 * debug tools see it through this.
 */
import type { Game } from '../Game';
import type { Body, CurrentSystem, Station, StarSystem } from '../types';

/** How far a body or station is and how big it looks this frame (for the overlay's markers). */
export interface ViewInfo {
  dist: number; // m from the ship
  pxR: number; // apparent radius in pixels
}

export interface GameRenderer {
  readonly kind: 'webgpu';
  /** The canvas it draws into (the HUD's overlay canvas sits on top of it). */
  readonly canvas: HTMLCanvasElement;
  /** A new system: everything in it, and every other system within sight as a star in the sky. */
  setSystem(cur: CurrentSystem, sky: StarSystem[]): void;
  resize(W: number, H: number): void;
  /** At the end of each frame: its start (ms) and the CPU's time over it (ms), for the dynamic resolution. */
  pace(now: number, cpuMs: number): void;
  render(g: Game): void;
  dispose(): void;
  bodyView(b: Body): ViewInfo | undefined;
  stationView(st: Station): ViewInfo | undefined;
}
