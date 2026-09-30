/*
 * Auto-exposure: the "eye" adapts to whatever you're looking at, like a camera or a pupil.
 *
 * Scene units. Every shader works in one scale ("scene luminance"): a sunlit surface reads ~SUNLIT
 * (0.55) whatever the star. Real light levels span far more than is pleasant to watch the eye
 * chase (night sky ~1e-8 of sunlight, a star's disc ~1e5×), so each source's level relative to
 * sunlight is squashed as level^GAMMA (0.4): the order stays the same, the range shrinks.
 *   - the Milky Way and the stars: SKY_K (0.025, from ~1e-4); fully dark-adapted, MAX_EXP =
 *     1/SKY_K, the sky looks as it always did (stars follow only part of it, see STAR_EXP_P);
 *   - station floodlights (30 lux), hangar lamps (500 lux), lit windows, and the ship's
 *     headlight (a 5 kW LED floodlight, 1.3 million cd, inverse-square; squashed at 100 m);
 * Stars' discs and glow, and signal lights (nav, approach, slot rim, pads, the approach corridor,
 * the orbit ring, dust and station beacons) are display-referred instead: they're added after exposure, so they look the
 * same in sunlight and in the dark, like a well-designed beacon does to the eye.
 *
 * Pipeline (gpu/GpuRenderer.ts): the frame is drawn into a half-float target, with every
 * physical shader multiplied by the current exposure (frame.exposure, "pre-exposure", which keeps
 * the values in half-float's range). The frame is shrunk 64× and read back asynchronously (gpu/meter.ts); the meter
 * turns that into scene luminance and picks a target exposure (see meter), and the exposure eases
 * toward it in log space: quicker when the view gets brighter than into the dark, as eyes do. A
 * final pass rolls the highlights off with a soft shoulder (linear below 0.8), so a sunlit scene looks as before (exposure ≈ 1).
 *
 * The effects: stars fade next to a sunlit planet (the system's star in view doesn't dim them); in a world's
 * shadow they come back, and a station's floodlights and your headlights become plainly visible.
 */
/**
 * Auto-exposure switch. Off (for now): exposure stays at 1, the frame is only tone-mapped (no
 * metering), and every light uses a fixed display level instead of its squashed physical one: the
 * sky and stars as they always looked, floodlights 0.28, hangar lamps 1.0, windows 0.7, and a
 * headlight that reads 1.8 at 100 m. Set to true to bring the eye adaptation back.
 */
export const AUTO_EXPOSURE = false;

export const SUNLIT = 0.55;
const SUN_LUX = 1e5;
/** How much the real range of light levels is squashed (see above). */
const GAMMA = 0.4;
/** Scene brightness of a white surface lit by `lux`, squashed. */
const lit = (lux: number) => SUNLIT * (lux / SUN_LUX) ** GAMMA;
/** Floodlights on the hull, and the hangar (its lamps ≙ 1.0 in the interior shader). */
export const FLOOD_K = AUTO_EXPOSURE ? lit(30) : 0.28,
  INT_K = AUTO_EXPOSURE ? lit(500) : 1;
/** Headlight: K / d² in the shaders, matching lit() at 100 m (1.3 million cd). */
export const HEAD_K = (AUTO_EXPOSURE ? lit(1.3e6 / 100 ** 2) : 1.8) * 100 ** 2;
/** Lit windows (~200 cd/m²) against their old display level. */
export const WINDOW_K = AUTO_EXPOSURE ? 0.18 : 1;
/** City lights on a world's night side (render/shaders/cityLights.glsl), at their brightest. */
export const CITY_K = AUTO_EXPOSURE ? 0.1 : 0.9;
/** The sky (Milky Way, stars, distant worlds as dots) against sunlit surfaces. */
export const SKY_K = AUTO_EXPOSURE ? 0.025 : 1;

/** Exposure limits: fully dark-adapted shows the sky as it used to be. */
const MIN_EXP = 0.25;
export const MAX_EXP = 40; // 1 / SKY_K with auto-exposure on
/**
 * Stars (points) follow only part of the exposure: (exposure / MAX_EXP)^STAR_EXP_P, so fully
 * dark-adapted they're as always, and next to a sunlit world (exposure ~1) they keep ~30%
 * instead of 2.5% (really they'd vanish, but a black sky around a planet isn't fun to fly in).
 * The Milky Way's glow does the same with SKY_EXP_P: ~40% next to a sunlit world.
 */
export const STAR_EXP_P = 0.33,
  SKY_EXP_P = 0.25;
/** The centre-weighted log-average lands here… */
const KEY = 0.18;
/** …unless that would push the brightest HIGHLIGHT_SHARE of the frame above this. */
const WHITE = 0.9;
/**
 * "Sunny 16": while sunlit things fill a real part of the view, exposure stays at 1 (sunlight),
 * as a photographer's does; the cap lifts steeply as they shrink ((SUNNY / highlights)⁴ below it).
 */
const SUNNY = 0.05;
/** Adaptation rates (1/s, in log exposure): toward a brighter view, and into the dark. */
const ADAPT_BRIGHT = 2,
  ADAPT_DARK = 1;

export class AutoExposure {
  /** Current exposure: scene luminance × value = display value. */
  value = 1;
  /** Where it's heading, and the last reading (scene luminance: centre-weighted log-average, the highlight level), for debugging. */
  target = 1;
  stats = { mean: 0, max: 0 };
  private last = 0;
  private first = true;

  /**
   * Each frame: take a finished meter reading if one has landed (gpu/meter.ts reads the frame back
   * asynchronously; `tag` is the exposure it was drawn at) and ease the exposure toward the target.
   */
  update(got: { data: Float32Array; w: number; h: number; tag: number } | null) {
    if (!AUTO_EXPOSURE) return; // fixed at 1
    if (got) {
      this.target = meter(got.data, got.w, got.h, got.tag, this.stats);
      if (this.first) this.value = this.target;
      this.first = false;
    }
    const now = performance.now() / 1000;
    const dt = this.last ? Math.min(0.2, now - this.last) : 0;
    this.last = now;
    const d = Math.log(this.target) - Math.log(this.value);
    const k = 1 - Math.exp(-(d < 0 ? ADAPT_BRIGHT : ADAPT_DARK) * dt);
    this.value = Math.exp(Math.log(this.value) + d * k);
  }
}

/** Share of the frame that has to be bright before it caps the exposure (smaller things may blow out). */
const HIGHLIGHT_SHARE = 0.02;
const scratch: number[] = [];

/**
 * The target exposure from a small image of the frame (RGBA floats, drawn at exposure `exp`; each
 * value is the average over a ~64 px patch):
 *   - the centre-weighted log-average of scene luminance maps to KEY (a log-average, so a small
 *     bright moon doesn't drag a starry view dark, and black sky doesn't wash out a planet);
 *   - but the brightest HIGHLIGHT_SHARE of the frame is held at WHITE, so a sunlit world or a
 *     star's glare that fills a real part of the view pulls the exposure down;
 *   - and while sunlit things fill that share, it stays at 1 (SUNNY).
 */
export function meter(
  data: Float32Array,
  w: number,
  h: number,
  exp: number,
  out?: { mean: number; max: number },
) {
  let sum = 0,
    wsum = 0;
  const aspect = w / h;
  scratch.length = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const L = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / exp;
      if (!(L >= 0)) continue; // NaN guard
      const u = ((x + 0.5) / w - 0.5) * aspect,
        v = (y + 0.5) / h - 0.5;
      const wt = Math.exp(-(u * u + v * v) / (2 * 0.3 * 0.3));
      sum += wt * Math.log(L + 1e-8);
      wsum += wt;
      scratch.push(L);
    }
  }
  const mean = wsum > 0 ? Math.exp(sum / wsum) : 0;
  scratch.sort((a, b) => b - a);
  const high =
    scratch[Math.min(scratch.length - 1, Math.floor(scratch.length * HIGHLIGHT_SHARE))] ?? 0;
  if (out) {
    out.mean = mean;
    out.max = high;
  }
  const t = Math.min(
    mean > 0 ? KEY / mean : MAX_EXP,
    high > 0 ? WHITE / high : MAX_EXP,
    high > 0 ? Math.max(1, (SUNNY / high) ** 4) : MAX_EXP,
  );
  return Math.min(MAX_EXP, Math.max(MIN_EXP, t));
}
