/**
 * Settings (the pause menu's Settings panel; docs/settings.md): sound levels and graphics options,
 * kept in the browser (localStorage), separate from the save game, so a new game keeps them.
 * Game.setSetting applies a change at once and remembers it.
 */

export interface Settings {
  /** Everything's loudness, 0…1 (× the mix's own level). */
  volume: number;
  /** The life support's hum in the cabin, 0…1 (it's what you hear sitting still). */
  hum: number;
  /** Frame rate: as fast as the display refreshes, or held to 60 (cooler, quieter, and the dynamic resolution aims for it). */
  fps: 'display' | '60';
  /** Dynamic resolution (gpu/dynres.ts): the scene's resolution drops to keep up. */
  dynres: boolean;
  /** The scene's resolution at most, as a share of the canvas's (1 = full). */
  resScale: 1 | 0.75 | 0.5;
  /** Volumetric clouds: full quality, half the steps, or off (the flat deck only). */
  clouds: 'high' | 'low' | 'off';
  bloom: boolean;
  flare: boolean;
  /** The sea mirroring land, ships and stations (tonemap.wgsl seaReflect; the sky's always in it). */
  reflections: boolean;
  /** Near things' shadows (ships, stations, rocks, the ground near you: gpu/shadowmap.ts's cascades). */
  shadows: boolean;
  /** The terrain's detail: high, or low (each chunk's quads twice as big on screen: ~a quarter of the chunks). */
  terrain: 'high' | 'low';
  /** The zoom blur toward where you're heading in FTL. */
  ftlBlur: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 1,
  hum: 1,
  fps: 'display',
  dynres: true,
  resScale: 1,
  clouds: 'high',
  bloom: true,
  flare: true,
  reflections: true,
  shadows: true,
  terrain: 'high',
  ftlBlur: true,
};

const KEY = 'farlight.settings';

/** The saved settings, over the defaults (a setting added since keeps its default). */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* no storage, or unreadable: the defaults */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* not remembered */
  }
}
