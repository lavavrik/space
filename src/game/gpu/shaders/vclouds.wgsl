// Volumetric clouds (docs/clouds.md): the cloud deck of the world you're near, ray-marched as a
// layer of real thickness, at half resolution, then laid over the frame by the tone map. The cover
// comes from the world's baked cloud cube (the same pattern the flat deck and the cloud shadows
// use), shaped by a height profile (thicker clouds rise higher) and eroded by 3D noise; each sample
// is lit by the sun through the cloud above it (a short march toward it), with a forward-scattering
// phase function and a little skylight. The march stops at the scene's depth, so terrain and
// mountains poke through, and the clouds are hazed by the air in front of them. Each pixel's march
// starts at a jittered offset, and the result is blended with the last frame's (reprojected by the
// clouds' distance), so the jitter's grain averages out over a few frames.
//
// Light shafts: below the deck, the air's haze along the ray is dimmed where the clouds hide the sun
// from it (the share of the ray, weighted by the air's density, whose sunward line crosses cloud),
// written as negative light, so the tone map's scene × T + light takes it off the sky and the ground.
// #include frame
// #include world
// #include noise
// #include noise3d
// #include clouds
// #include atmo
// #include ringband
// #include shadow

struct VParams {
  prevVP: mat4x4f, // last frame's view-projection (camera-relative then)
  moved: vec4f,    // xyz: unused (0; prevVP carries the world's motion, vclouds.ts); w: 1 if last frame's result is usable
  size: vec2f,     // the output (px)
  on: f32,         // 0…1: fades in as you come down toward the deck
  frameN: f32,     // frame counter (the start jitter moves)
  near: f32,       // the projection's near plane (depth = near / distance along the view axis)
  scale: f32,      // frame pixels per march pixel
  _p1: f32,
  _p2: f32,
}
@group(2) @binding(0) var sceneDepth: texture_depth_multisampled_2d;
@group(2) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(2) var<uniform> vp: VParams;
@group(2) @binding(3) var history: texture_2d<f32>;
@group(2) @binding(4) var histSamp: sampler;

const STEPS: i32 = 48;
const SUN_STEPS: i32 = 5;
const SIGMA: f32 = 0.004;    // extinction per metre at full density (visibility a few hundred m)
const MAX_DIST: f32 = 250000.0;

var<private> rBot: f32;
var<private> rTop: f32;

// (0…1) cloud density at a camera-relative point
fn density(P: vec3f) -> f32 {
  let Pc = P - world.atC.xyz;
  let r = length(Pc);
  let h = (r - rBot) / (rTop - rBot);
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let lp = toLocalM() * Pc;
  let k = lp * 0.00045 + vec3f(world.time * 0.00002, 0.0, 0.0);
  // the cube's cover: where the weather is (hundreds of km)
  let cov0 = cloudCover(textureSampleLevel(cloudTex, cloudSamp, lp / r, 0.0).r);
  // Shaped like weather, not a sponge (cutting holes all over the cover with one noise read as
  // round craters of one size; tnoise is value noise, mostly within ±0.35, so thresholds are narrow;
  // a noise texel is ~2.8 km at k × 0.1):
  //   - the wind blows round the world's axis (its local y): shapes are stretched ~2× along it,
  //     so clouds run in streets and bands, and a slow swirl warps them, so edges are ragged;
  //   - the heart of a weather system (thick cover) stays a sheet: tens-of-km swells in how thick
  //     it is, not holes (overcast is stratus);
  //   - its edges (thinner cover) break up into clumps a few km across with gaps between (cumulus).
  let east = normalize(vec3f(lp.z, 0.0, -lp.x) + vec3f(1e-3, 0.0, 0.0));
  let ks = k - east * (dot(k, east) * 0.55);
  let sw = tnoise(ks * 0.06 + 3.0);
  let kw = ks + vec3f(sw, -0.7 * sw, 0.5 * sw) * 6.0;
  let swell = tnoise(kw * 0.035 + 11.0);
  let c = 0.7 * tnoise(kw * 0.18 + 23.0) + 0.3 * tnoise(kw * 0.5 + 7.0);
  let broken = 1.0 - smoothstep(0.45, 0.8, cov0);
  let clump = mix(1.0, smoothstep(-0.15, 0.1, c + 0.3 * swell), broken);
  let cov = min(cov0 * clump * (0.9 + 0.6 * swell), 1.0);
  if (cov < 0.02) { return 0.0; }
  // towers: thicker cover rises higher, and ~8 km cells rise and fall, so the tops aren't one carpet
  let cell = 0.5 + 0.5 * tnoise(kw * 0.27 + 5.0);
  let top = clamp(mix(0.25, 1.0, cov) * (0.45 + 0.75 * cell), 0.15, 1.0);
  let profile = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(top * 0.5, top, h));
  let base = cov * profile;
  if (base < 0.01) { return 0.0; }
  // erosion: billows a couple of km across and finer wisps (drifting with the wind), strongest at
  // the edges, so what's left is lumpy cauliflower rather than fog
  // (softer inside thick cover, or its tops were pocked all over with little shadowed pits, which
  // from high up read as dashes)
  let n = 0.55 * tnoise(k) + 0.3 * tnoise(k * 3.1) + 0.15 * tnoise(k * 9.3);
  let bite = mix(0.75, 0.45, smoothstep(0.5, 0.9, cov));
  return clamp((base - (1.0 - base) * (bite - bite * n)) * 3.0, 0.0, 1.0);
}

fn hg(c: f32, g: f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (d * sqrt(d)); // × 4π: 1 on average
}

// how much sunlight reaches camera-relative point P (below the deck) through the clouds above it
fn sunThrough(P: vec3f, L: vec3f) -> f32 {
  let Cp = world.atC.xyz - P;
  let a = sphereSpan(L, Cp, rBot).y;
  let b = sphereSpan(L, Cp, rTop).y;
  if (b <= a || a < 0.0) { return 1.0; }
  var od = 0.0;
  let ds = (b - a) / 3.0;
  for (var i = 0; i < 3; i++) { od += density(P + L * (a + (f32(i) + 0.5) * ds)) * ds; }
  return exp(-od * SIGMA * 0.5);
}

// where a ray from the camera along dir crosses the sphere of radius r round C: (near, far), or (1, 0)
fn sphereSpan(dir: vec3f, C: vec3f, r: f32) -> vec2f {
  let b = dot(dir, C);
  let disc = b * b - (dot(C, C) - r * r);
  if (disc < 0.0) { return vec2f(1.0, 0.0); }
  let s = sqrt(disc);
  return vec2f(b - s, b + s);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let px = vec2i(gid.xy);
  if (f32(px.x) >= vp.size.x || f32(px.y) >= vp.size.y || vp.on <= 0.0) {
    if (f32(px.x) < vp.size.x && f32(px.y) < vp.size.y) { textureStore(outTex, px, vec4f(0.0, 0.0, 0.0, 1.0)); }
    return;
  }
  let full = (vec2f(px) + 0.5) * vp.scale;
  let dir = viewDir(full);
  let C = world.atC.xyz;
  rBot = world.radius + world.cloudH * 0.4;
  rTop = world.radius + world.cloudH * 1.05;
  // the segment of the ray inside the layer (the near one)
  let camR = length(C);
  let top = sphereSpan(dir, C, rTop);
  let bot = sphereSpan(dir, C, rBot);
  var t0 = 0.0;
  var t1 = 0.0;
  if (camR < rBot) {
    t0 = bot.y;
    t1 = top.y;
  } else if (camR < rTop) {
    t0 = 0.0;
    t1 = select(top.y, bot.x, bot.y > bot.x && bot.x > 0.0);
  } else if (top.y > top.x && top.x > 0.0) {
    t0 = top.x;
    t1 = select(top.y, bot.x, bot.y > bot.x && bot.x > 0.0);
  }
  // the scene in front ends it
  let d = textureLoad(sceneDepth, vec2i(full), 0);
  if (d > 0.0) {
    let fwd = -normalize(frame.camRot[2].xyz);
    t1 = min(t1, vp.near / d / max(dot(dir, fwd), 1e-4));
  }
  t1 = min(t1, t0 + MAX_DIST);
  let L = normalize(world.light.xyz);
  let j = fract(52.9829189 * fract(dot(vec2f(px) + vp.frameN * 5.588238, vec2f(0.06711056, 0.00583715))));
  // light shafts (below the deck): the haze along the ray, less where the clouds shade the air
  var dark = vec3f(0.0);
  var skyDim = 1.0;
  if (camR < rBot && world.atOn > 0.5) {
    // the air under the deck along the ray: to the ground or to the cloud base (toward the horizon
    // ~200 km); the shade is sampled over its first 30 km and taken for all of it (only the first
    // 30 km were dimmed, and the rest, reddened by its long path, glowed as a yellow band along the
    // horizon under overcast)
    var tFull = atSpan(dir).y;
    if (d > 0.0) { tFull = min(tFull, vp.near / d / max(dot(dir, -normalize(frame.camRot[2].xyz)), 1e-4)); }
    if (bot.y > 0.0) { tFull = min(tFull, bot.y); }
    let tEnd = min(tFull, 30000.0);
    var shade = 0.0;
    var wsum = 0.0;
    for (var i = 0; i < 12; i++) {
      let P = dir * (tEnd * (f32(i) + j) / 12.0);
      let w = atDens(length(P - C));
      shade += (1.0 - sunThrough(P, L)) * w;
      wsum += w;
    }
    let frac = 0.92 * shade / max(wsum, 1e-6);
    // to the ground: that stretch's haze taken off (the ground itself has the clouds' shadow). Into
    // the sky: the sky dimmed as a whole instead (the sky's haze is compressed over a knee, atmo.wgsl
    // atRolloff, and taking a stretch's compressed haze off it left a reddish line on the horizon)
    if (d > 0.0) {
      // (mostly: the far ground is mostly haze; near, the ground's own shading does it)
      skyDim = 1.0 - frac * smoothstep(2000.0, 30000.0, tFull);
    } else {
      skyDim = 1.0 - frac;
    }
  }
  // (a ray that misses the layer marches nothing, but still goes through the blend below)
  let steps = select(0, STEPS, t1 > t0);
  let cosT = dot(dir, L);
  let mid = dir * (0.5 * (t0 + t1)) - C;
  let sunCol = atSunlightC(normalize(mid) * (world.radius + world.cloudH), L) * sunShade(mid) * world.atSunI / 45.0;
  let dayK = smoothstep(-0.15, 0.3, dot(normalize(mid), L));
  let span = t1 - t0;
  // (the start is jittered: banding becomes fine grain, averaged out over frames.) Steps are spaced
  // quadratically, fine near the camera and coarse far off: evenly, a ray skimming the layer 250 km
  // took 5 km steps and one ending 20 km off at the cloud base 400 m ones, so from inside the layer
  // the fog built up differently either side of the base's horizon, a hard line across the view
  var T = 1.0;
  var S = vec3f(0.0);
  var tFirst = -1.0;
  var tSum = 0.0; // distance weighted by how much each step shows (for the reprojection)
  var wSum = 0.0;
  for (var i = 0; i < steps; i++) {
    let u = (f32(i) + j) / f32(STEPS);
    let t = t0 + span * u * u;
    let dt = span * 2.0 * max(u, 0.5 / f32(STEPS)) / f32(STEPS);
    let P = dir * t;
    let dn = density(P);
    if (dn <= 0.0) { continue; }
    if (tFirst < 0.0) { tFirst = t; }
    // sunlight reaching here through the cloud toward the sun
    var od = 0.0;
    var ls = 120.0;
    var lt = 0.0;
    for (var k = 0; k < SUN_STEPS; k++) {
      lt += ls;
      od += density(P + L * lt) * ls;
      ls *= 2.0;
    }
    // light scattered many times inside the cloud (Frostbite's approximation: octaves each less
    // attenuated, weaker and less forward): clouds are bright from every side, not just sunward
    var sun = 0.0;
    var a = 1.0;
    var bw = 1.0;
    var g = 0.65;
    for (var o = 0; o < 3; o++) {
      sun += bw * exp(-od * SIGMA * a) * mix(hg(cosT, g), hg(cosT, -0.2 * g), 0.25);
      a *= 0.35;
      bw *= 0.5;
      g *= 0.5;
    }
    let h = clamp((length(P - C) - rBot) / (rTop - rBot), 0.0, 1.0);
    let light = sunCol * (sun * 0.6 + 0.12 * (0.4 + 0.6 * h)) * dayK * 0.97;
    let tStep = exp(-dn * SIGMA * dt);
    S += T * light * (1.0 - tStep);
    tSum += t * T * (1.0 - tStep);
    wSum += T * (1.0 - tStep);
    T *= tStep;
    if (T < 0.01) { break; }
  }
  // the air in front of the cloud: its haze and how much it dims
  if (tFirst > 0.0 && world.atOn > 0.5) {
    let span = atSpan(dir);
    let haze = atInscatter(dir * span.x, dir * max(tFirst, span.x), L, 4);
    S = S * atTrans + haze * (1.0 - T) * skyDim; // (under the deck, that air is shaded too)
  }
  var res = vec4f((S - dark) * frame.exposure, T * skyDim);
  // with last frame's: where this pixel's clouds were then (by their distance, or the layer's middle)
  if (vp.moved.w > 0.5) {
    var tr = select(15000.0, 0.5 * (t0 + t1), steps > 0); // (no layer here: a shaft's typical distance)
    // (where the visible cloud mostly is: inside fog the first sample is metres off, and reprojecting
    // by it while moving fetched the wrong history, leaving the jitter as static)
    if (wSum > 0.02) { tr = tSum / wSum; } else if (tFirst > 0.0) { tr = tFirst; }
    let q = vp.prevVP * vec4f(dir * tr + vp.moved.xyz, 1.0);
    if (q.w > 0.0) {
      let uv = vec2f(q.x / q.w * 0.5 + 0.5, 0.5 - q.y / q.w * 0.5);
      if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) {
        res = mix(textureSampleLevel(history, histSamp, uv, 0.0), res, 0.2);
      }
    }
  }
  textureStore(outTex, px, res);
}
