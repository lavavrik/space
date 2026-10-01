// Cloud cover (render/shaders/clouds.glsl): cloudRaw is what the per-world bake evaluates (into a
// cube map in the world's own frame), cloudCover turns a raw value into cover (0…1).
// The weather turns round the world's axis (its local y) a little faster than the ground: ~16 m/s
// at an Earth's equator (sim/clouds.ts CLOUD_WIND). A local direction → where in the (baked, still)
// cloud map it is now. Everything that reads the map goes through it (the deck, the volumetric
// clouds, their shadows on the ground), so they move together.
const CLOUD_WIND: f32 = 2.5e-6; // rad/s
fn cloudDir(p: vec3f) -> vec3f {
  let a = -world.time * CLOUD_WIND;
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

// The weather map now: the baked map read twice, once moving with the wind (cloudDir) and once
// slower, round a tilted axis and from another part of the map; the two slide past each other, so
// weather systems grow, merge and die away over hours instead of only turning round the world.
// `p`: a unit direction in the world's own frame.
fn cloudMap(p: vec3f) -> f32 {
  let a = cloudDir(p);
  let ang = -world.time * CLOUD_WIND * 0.55;
  let axis = normalize(vec3f(0.35, 1.0, 0.2));
  let b = p * cos(ang) + cross(axis, p) * sin(ang) + axis * dot(axis, p) * (1.0 - cos(ang));
  let s1 = textureSampleLevel(cloudTex, cloudSamp, a, 0.0).r;
  let s2 = textureSampleLevel(cloudTex, cloudSamp, vec3f(b.z, -b.y, b.x), 0.0).r;
  return (s1 + s2) * 0.7; // (two independent fields: × 0.7 keeps the spread about the same)
}

// How far the cloud layer is lifted over high ground (m), at a unit direction in the world's own
// frame (not the wind's: the ground stays put): enough for the volumetric layer's base (0.4 deck
// heights) to clear the ground's coarse height (the cube's second channel, cloudBake.wgsl) by
// LIFT_CLEAR, as gpu/worlds.ts's vcLift does for the ground under you, plus a fifth of the relief
// for the peaks finer than the bake. Without it the plateaus and
// ranges rose through the clouds and cut them off (up to ~1.3 × the relief: on an Earth-like world
// a fifth of the ground is over the base): from orbit, gaps with the haze's gradient round them.
const LIFT_CLEAR: f32 = 1200.0;
fn cloudLiftAt(p: vec3f) -> f32 {
  let g = textureSampleLevel(cloudTex, cloudSamp, p, 0.0).g;
  return max(g + (LIFT_CLEAR + 0.2 * world.terrA) * smoothstep(0.0, 500.0, g) - world.cloudH * 0.4, 0.0); // (none over the sea)
}
// …at most (the ground's at most ~1.3 × the relief)
fn cloudLiftMax() -> f32 { return max(world.terrA * 1.6 + LIFT_CLEAR - world.cloudH * 0.4, 0.0); }

// Shapes stretched along the wind, which blows along the latitude circles (round the local y axis):
// a point's longitude in the weather's frame is scaled by `s` (each latitude circle turned by its
// own angle), so 3D noise read there is 1/s longer along the wind, with no shear. (Squashing a
// point's own coordinates along its east does nothing: east is square to where the point is. The
// shapes came out round, SPACE-74.) The scaled longitude jumps where it wraps; that seam is put on
// the meridian opposite the camera (`seam`, windSeam), and a second layout, seamed under the camera,
// takes over within ~45° of it (windBlend). Each layout's value only changes where its weight is 0
// as you move, so nothing visibly jumps. `p`: a point in the weather's frame (m).
const TAU: f32 = 6.2831853;
var<private> wSeam: f32 = 1e9; // (worked out once per pixel: the density's called hundreds of times)
fn windSeam() -> f32 {
  if (wSeam > 100.0) {
    let toL = mat3x3f(world.toLocal[0].xyz, world.toLocal[1].xyz, world.toLocal[2].xyz);
    let c = cloudDir(toL * -world.atC.xyz);
    wSeam = atan2(c.x, c.z) + 0.5 * TAU;
  }
  return wSeam;
}
fn windStretch(p: vec3f, s: f32, seam: f32) -> vec3f {
  let lon = atan2(p.x, p.z);
  let a = (seam + fract((lon - seam) / TAU) * TAU) * s;
  let rxz = length(p.xz);
  return vec3f(rxz * sin(a), p.y, rxz * cos(a));
}
// the second layout's share at p (its seam is seam − π)
fn windBlend(p: vec3f, seam: f32) -> f32 {
  let d = abs(fract((atan2(p.x, p.z) - seam) / TAU + 0.5) - 0.5) * TAU; // (angle from the seam)
  return 1.0 - smoothstep(0.1 * TAU, 0.13 * TAU, d);
}

// The cover shaped like weather (vclouds.wgsl density, and the flat deck: they match), from the
// cube's cover `cov0` at `lp`, a point in the weather's own turning frame (m, cloudDir):
//   - the wind blows round the world's axis: shapes are stretched ~2× along it (windStretch), so
//     clouds run in streets and bands, and a slow swirl warps them, so edges are ragged;
//   - the heart of a weather system (thick cover) stays a sheet: tens-of-km swells in how thick
//     it is, not holes (overcast is stratus);
//   - its edges (thinner cover) break up into clumps a few km across with gaps between (cumulus).
// (tnoise is value noise, mostly within ±0.35, so thresholds are narrow; a noise unit of kw is
// ~2.2 km.) `res`: how far the clumps are resolved (1 up close; toward 0 where they're under a
// pixel, they average out to their share of the area)
struct Weather {
  cov: f32,
  kw: vec3f, // (the warped, stretched coordinates, for more shapes on the same streets)
}
fn weatherAt(lp: vec3f, seam: f32, cov0: f32, res: f32) -> Weather {
  let ks = windStretch(lp, 0.45, seam) * 0.00045;
  let sw = tnoise(ks * 0.06 + 3.0);
  let kw = ks + vec3f(sw, -0.7 * sw, 0.5 * sw) * 6.0;
  // (shapes evolve too: swells over ~an hour, clumps and towers over ~15 min)
  let tv = vec3f(0.0, world.time, 0.0);
  let swell = tnoise(kw * 0.035 + 11.0 + tv * 7e-5);
  var c = 0.0;
  if (res > 0.01) { c = 0.7 * tnoise(kw * 0.18 + 23.0 + tv * 2.8e-4) + 0.3 * tnoise(kw * 0.5 + 7.0 + tv * 2.8e-4); }
  let broken = 1.0 - smoothstep(0.45, 0.8, cov0);
  let clump = mix(1.0, mix(0.55, smoothstep(-0.15, 0.1, c + 0.3 * swell), res), broken);
  return Weather(min(cov0 * clump * (0.9 + 0.6 * swell), 1.0), kw);
}
fn weatherCover(lp: vec3f, cov0: f32, res: f32) -> Weather {
  let seam = windSeam();
  let w = weatherAt(lp, seam, cov0, res);
  let b = windBlend(lp, seam);
  if (b <= 0.0) { return w; }
  let w2 = weatherAt(lp, seam - 0.5 * TAU, cov0, res);
  return Weather(mix(w.cov, w2.cov, b), select(w.kw, w2.kw, b > 0.5));
}

// Storms (docs/clouds.md): in the thickest weather, areas a few hundred km across where the cloud
// towers up to the layer's top and spreads into an anvil, and lightning flashes inside it. `lp`: a
// point in the weather's frame (m); `cov0`: the cube's cover there. 0…1.
fn stormAt(lp: vec3f, cov0: f32) -> f32 {
  if (cov0 <= 0.7) { return 0.0; } // (the noise read only where it can matter)
  return smoothstep(0.7, 0.85, cov0) * smoothstep(0.2, 0.32, tnoise(lp * 5e-6 + 71.0));
}
// Lightning: the storms are cut into STORM_CELL cells (a 3D grid through the world), each with a
// flash point at mid-cloud height (FLASH_R from the centre); every 0.8 s a cell flashes with a 1 in
// 7 chance (if it's in a storm), flickering for a quarter of that, lighting the cloud round its
// point (a Gaussian, 10 km; from orbit, at 3 and 7 km, they were too small and faint to see). Only a point's own cell counts (its glow is gone by the cell's edge).
// Its clock is world.waveO.w: the time wrapped to an hour, precise (the sim's own is in steps of
// 0.25 s). Returns the flash's light at lp (×, with STORM_FLASH, the sun's at full).
const STORM_CELL: f32 = 60000.0;
const STORM_FLASH: f32 = 8.0;
// (an integer hash, PCG-style: sin of large arguments, the usual shader hash, is too imprecise on
// GPUs and came out nearly constant, so no cell ever flashed)
fn cloudHashU(c: vec3i, s: u32) -> f32 {
  var v = bitcast<vec3u>(c) * 1664525u + vec3u(1013904223u, 2654435769u, s * 747796405u + 1u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return f32(v.x & 0xffffffu) / 16777216.0;
}
fn flashAt(lp: vec3f, flashR: f32) -> f32 {
  let cell = floor(lp / STORM_CELL);
  let ci = vec3i(cell);
  let h0 = cloudHashU(ci, 0u);
  let tt = world.waveO.w / 0.8 + h0 * 97.0;
  let slot = floor(tt);
  if (cloudHashU(ci, 7u + u32(slot)) < 0.85) { return 0.0; }
  let ph = tt - slot;
  let env = select(0.0, (0.55 + 0.45 * sin(ph * 90.0 + h0 * 6.0)) * (1.0 - ph * 3.0), ph < 0.33);
  if (env <= 0.0) { return 0.0; }
  // (its point within the middle tenth of the cell: ≥ 27 km from its edges, where its glow is gone)
  let c = normalize((cell + 0.45 + 0.1 * vec3f(h0, cloudHashU(ci, 1u), cloudHashU(ci, 2u))) * STORM_CELL) * flashR;
  // (cloudMap takes the world's own frame and turns it to the weather's: back from it, the angle's
  // inverse)
  let a = world.time * CLOUD_WIND;
  let cw = normalize(c);
  let cov0 = cloudCover(cloudMap(vec3f(cos(a) * cw.x + sin(a) * cw.z, cw.y, -sin(a) * cw.x + cos(a) * cw.z)));
  let st = stormAt(c, cov0);
  if (st <= 0.0) { return 0.0; }
  let d = length(lp - c);
  return env * st * exp(-d * d / (10000.0 * 10000.0)) * STORM_FLASH;
}

// The glow of cities under the clouds at night (docs/clouds.md): their light scattered up through
// the cloud, warm, by how populated the ground is below (city.wgsl cityPop, from the cube's coarse
// ground height), where both suns are down. `pw`: a unit direction in the world's own frame. In
// scene light (× exposure).
fn cityGlowAt(pw: vec3f, L: vec3f, up: vec3f) -> vec3f {
  if (world.city < 0.5 || world.terrA <= 0.0) { return vec3f(0.0); }
  let night = smoothstep(0.05, -0.12, dot(up, L)) * select(1.0, 1.0 - smoothstep(-0.12, 0.05, dot(up, normalize(world.light2.xyz + vec3f(0.0, 1e-9, 0.0)))) * min(1.0, 4.0 * max(world.lightC2.r, max(world.lightC2.g, world.lightC2.b))), world.light2.w > 0.5);
  if (night <= 0.0) { return vec3f(0.0); }
  let g = textureSampleLevel(cloudTex, cloudSamp, pw, 0.0).g;
  return vec3f(1.0, 0.72, 0.42) * 0.14 * cityPop(pw, g / world.terrA, abs(pw.y)) * night;
}

fn cloudRaw(p: vec3f, oct: i32) -> f32 {
  let s = world.seed;
  let cp = (p * 1.6 + vec3f(s * 1.7, s * 2.3, s * 0.9)) * 1.25;
  return fbmF(cp + fbmF(cp * 2.0, 4) * 0.7, oct);
}
// Earth-like and ocean worlds (wtype 2, 3) are clouded over most of their face, with clear
// stretches between weather systems (at the others' threshold, from 0.02, about half their face was
// bare, and the volumetric clouds' own gaps, vclouds.wgsl, left most of the rest clear too)
fn cloudCover(raw: f32) -> f32 {
  let wet = world.wtype == 2 || world.wtype == 3;
  return smoothstep(select(0.02, -0.2, wet), select(0.5, 0.25, wet), raw) * select(0.85, 0.95, world.wtype == 3);
}
