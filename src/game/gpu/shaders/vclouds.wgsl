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
// #include city
// #include clouds
// #include giant
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
  lift: f32,       // how far the layer's lifted over the high ground under you (m; see liftAt)
  quality: f32,    // the share of the steps marched (Settings: 1, or 0.5)
}
@group(2) @binding(0) var sceneDepth: texture_depth_multisampled_2d;
@group(2) @binding(1) var outTex: texture_storage_2d<rgba16float, write>;
@group(2) @binding(2) var<uniform> vp: VParams;
@group(2) @binding(3) var history: texture_2d<f32>;
@group(2) @binding(4) var histSamp: sampler;

const STEPS: i32 = 48;
/** Inside the layer: more steps over a shorter reach (48 over 250 km banded the clouds across a gap). */
const STEPS_IN: i32 = 64;
const MAX_DIST_IN: f32 = 100000.0;
const SUN_STEPS: i32 = 5;
// the share of the light a cloud sends back toward the sun (a weaker, backward lobe of the phase
// function): thick cloud is bright seen from the sun's side, as from orbit by day (at 0.25 the tops
// were grey, darker than the snow under them)
const BACK: f32 = 0.5;
/** The haze's particles' scattering at ground density (1/m, grey): the god rays' light. */
const MIE_B: f32 = 6e-6;
const SIGMA: f32 = 0.004;    // extinction per metre at full density (visibility a few hundred m)
const MAX_DIST: f32 = 250000.0;
/** Dust's density at most, of a cloud's (density): ~1 km of visibility in a storm's heart. */
const DUST_THIN: f32 = 0.3;
/** …and an acid deck's (Venus's: visibility of a few km in it). */
const ACID_THIN: f32 = 0.4;

var<private> rBot: f32;
var<private> rTop: f32;
var<private> liftTop: f32; // the lift at most (the march must reach the lifted top)
var<private> liftCam: f32; // …and over the ground under you (whether you're in the layer or above it)

// The layer is lifted over high ground (clouds.wgsl cloudLiftAt: by the baked coarse height,
// ~12 km texels), and near you by the ground under you exactly (vp.lift: enough for its base to
// clear it by ~1.2 km), fading back 30–80 km away. Over a plateau or in the mountains it sat on the
// ground, and from orbit the highlands cut holes in it. (Peaks finer than the bake can still rise
// into it, as mountains do.)
fn liftAt(P: vec3f) -> f32 {
  var l = cloudLiftAt(toLocalM() * normalize(P - world.atC.xyz));
  if (vp.lift > 0.0) {
    let up = normalize(-world.atC.xyz);
    let hd = length(P - up * dot(P, up));
    l = max(l, vp.lift * (1.0 - smoothstep(30000.0, 80000.0, hd)));
  }
  return l;
}
fn setLifts() {
  liftTop = max(vp.lift, cloudLiftMax());
  liftCam = liftAt(vec3f(0.0));
}

// (0…1) cloud density at a camera-relative point
fn density(P: vec3f) -> f32 {
  let Pc = P - world.atC.xyz;
  let r = length(Pc) - liftAt(P);
  let h = (r - rBot) / (rTop - rBot);
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  // in the weather's own turning frame (clouds.wgsl cloudDir): the cover and all its shapes blow along
  let lw = toLocalM() * Pc;
  let lp = cloudDir(lw);
  let k = lp * 0.00045;
  // the cube's cover: where the weather is (hundreds of km)
  let cov0 = cloudCover(cloudMap(lw / r));
  // Shaped like weather, not a sponge (cutting holes all over the cover with one noise read as
  // round craters of one size; tnoise is value noise, mostly within ±0.35, so thresholds are narrow;
  // a noise texel is ~2.8 km at k × 0.1):
  //   - the wind blows round the world's axis (its local y): shapes are stretched ~2× along it,
  //     so clouds run in streets and bands, and a slow swirl warps them, so edges are ragged;
  //   - the heart of a weather system (thick cover) stays a sheet: tens-of-km swells in how thick
  //     it is, not holes (overcast is stratus);
  //   - its edges (thinner cover) break up into clumps a few km across with gaps between (cumulus).
  // (clouds.wgsl weatherCover: the flat deck shapes its cover the same way)
  let wc = weatherCover(lp, cov0, 1.0);
  let kw = wc.kw;
  let tv = vec3f(0.0, world.time, 0.0);
  let cov = wc.cov;
  if (cov < 0.02) { return 0.0; }
  // Dust (desert worlds, docs/clouds.md "Kinds"): densest at the ground, thinning upward to a top
  // that rises with the storm (a few km at its edges, the deck's top in its heart), in big soft
  // lobes rolling along (a haboob's front), not towers and cauliflower; thin, DUST_THIN of a
  // cloud's density at most: a km or so of visibility in the thick of it
  if (cloudKind() == CK_DUST) {
    let tvD = vec3f(0.0, world.time, 0.0);
    let topD = mix(0.25, 1.0, cov) * (0.75 + 0.25 * tnoise(kw * 0.12 + 5.0 + tvD * 2.8e-4) * 2.0);
    let prof = exp(-h / max(topD * 0.4, 0.04)) * (1.0 - smoothstep(topD * 0.55, topD, h));
    let kd = k * 0.5 + tvD * 2e-4;
    let nd = 0.6 * tnoise(kd) + 0.4 * tnoise(kd * 2.7);
    return clamp(cov * prof * (0.75 + nd) * 1.6, 0.0, 1.0) * DUST_THIN;
  }
  // towers: thicker cover rises higher, and ~8 km cells rise and fall, so the tops aren't one carpet
  let cell = 0.5 + 0.5 * tnoise(kw * 0.27 + 5.0 + tv * 2.8e-4);
  var top = clamp(mix(0.25, 1.0, cov) * (0.45 + 0.75 * cell), 0.15, 1.0);
  // (an acid deck: one sheet, its top rolling a little, not towers)
  let acid = cloudKind() == CK_ACID;
  let giant = cloudKind() == CK_GIANT;
  if (acid) { top = 0.85 + 0.15 * cell; }
  // storms (clouds.wgsl stormAt): towers up to the layer's top, under an anvil, a flat sheet spread
  // over the storm near the top (12–14 km on an Earth)
  let st = stormAt(lp, cov0);
  top = mix(top, 1.0, st * smoothstep(0.35, 0.6, cell));
  var profile = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(top * 0.5, top, h));
  // A giant's (docs/giants.md "Clouds"), in scale heights from its face (z; its deck is a quarter of
  // one): its tops at the face, rolling from 0.13 under it to 0.26 over it, crisp (over 0.17: fading
  // over the layer's upper half they were a featureless glow from above); and two decks, as a
  // Jupiter's are (ammonia over ammonium hydrosulphide), clear air between, 0.57–0.84 under the face,
  // its floor and ceiling rolling (one deck all the way down was a featureless fog)
  if (giant) {
    let z = (length(Pc) - world.radius) / (world.cloudH * 4.0);
    let topZ = -0.13 + 0.39 * cell;
    let gw = 0.08 * tnoise(kw * 0.05 + 43.0);
    profile = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(topZ - 0.17, topZ, z));
    profile *= 1.0 - smoothstep(-0.95 + gw, -0.84 + gw, z) * (1.0 - smoothstep(-0.57 - gw, -0.46 - gw, z));
  }
  var base = cov * profile;
  // (its underside rising and falling, ~±1 km over tens of km, and its thickness patchy, so the
  // erosion below breaks it up: a flat, even sheet was featureless fog from inside it, its
  // underside a straight line across the view)
  if (st > 0.0) {
    let nA = tnoise(kw * 0.04 + 31.0);
    let nB = tnoise(kw * 0.25 + 37.0);
    let hb = 0.76 + 0.12 * nA;
    base = max(base, st * (0.3 + 0.45 * smoothstep(-0.2, 0.25, nB)) * smoothstep(hb, hb + 0.08, h) * (1.0 - smoothstep(0.94, 1.0, h)));
  }
  if (base < 0.01) { return 0.0; }
  // erosion: billows a couple of km across and finer wisps (drifting with the wind), strongest at
  // the edges, so what's left is lumpy cauliflower rather than fog
  // (softer inside thick cover, or its tops were pocked all over with little shadowed pits, which
  // from high up read as dashes)
  // (and they boil: the finest detail changes over a few minutes)
  let kb = k + vec3f(0.0, world.time * 3e-4, 0.0);
  let n = 0.55 * tnoise(kb) + 0.3 * tnoise(kb * 3.1) + 0.15 * tnoise(kb * 9.3);
  let bite = select(select(mix(0.75, 0.45, smoothstep(0.5, 0.9, cov)), 0.3, acid), 0.55, giant);
  // (an acid haze, not cloud: a few km of visibility in it, ACID_THIN of a cloud's density)
  return clamp((base - (1.0 - base) * (bite - bite * n)) * 3.0, 0.0, 1.0) * select(1.0, ACID_THIN, acid);
}

fn hg(c: f32, g: f32) -> f32 {
  let d = 1.0 + g * g - 2.0 * g * c;
  return (1.0 - g * g) / (d * sqrt(d)); // × 4π: 1 on average
}

// Cirrus, CIRRUS_H deck heights up (~11–14 km): wisps of ice crystals, not marched (a thin sheet,
// one lookup), and drawn at full resolution in fsComposite (at the march's half, blurred, they were
// soft). `lq`: a point in the weather's frame (m); `pm`: a pixel's footprint there (m).
//   - plumes and bands a few hundred km long, stretched ~5× along the wind and swirled, their edges
//     frayed by the streaks in them (not round patches with a soft rim: from orbit they read as
//     fuzzy blobs fading out at their edges);
//   - streaks ~15 km across running along them, which hold from orbit;
//   - fibres down to a few hundred metres, each fading to its mean once under a couple of pixels
//     (undersampled, they sparkled, and their soft mean was all that showed).
// Opacity 0…~0.5.
const CIRRUS_H: f32 = 1.35;
fn cirrus(lq: vec3f, pm: f32) -> f32 {
  // (stretched along the wind as the lower clouds are, clouds.wgsl windStretch)
  let seam = windSeam();
  let a = cirrusPat(lq, seam, pm);
  let b = windBlend(lq, seam);
  if (b <= 0.0) { return a; }
  return mix(a, cirrusPat(lq, seam - 0.5 * TAU, pm), b);
}
fn cirrusPat(lq: vec3f, seam: f32, pm: f32) -> f32 {
  let ks = windStretch(lq, 0.35, seam) * 0.00012; // (~3× along the wind)
  let sw = tnoise(ks * 0.08 + 17.0);
  let kf = ks + vec3f(sw, 0.6 * sw, -0.4 * sw) * 6.0;
  // (the streaks: swirled less, or they meandered like rivers, and stretched ~7× along the wind:
  // at 25× they were scratches)
  let kf2 = windStretch(lq, 0.14, seam) * 0.00012 + vec3f(sw, 0.6 * sw, -0.4 * sw) * 3.0;
  let streak = tnoise(kf2 * 0.5 + 13.0);
  // (the band's edge softened to a few pixels' footprint: near the horizon, a pixel spans tens of
  // km of the sheet, and the edge stepped from pixel row to row)
  let ew = min(pm / 150000.0, 0.3);
  let area = smoothstep(0.04 - ew, 0.12 + ew, tnoise(kf * 0.025 + 41.0) + 0.3 * streak);
  if (area <= 0.0) { return 0.0; }
  // filaments: ridged noise (thin lines where it crosses zero) along the wind; a noise unit of kf2
  // is ~8 km across it, so lines every ~16, 4, 1.4 and 0.5 km. Under a pixel each fades to its
  // mean (0.25); the widest ones' lines are a few km across, and toward the horizon those go too
  let v = 1.0 - smoothstep(vec3f(0.5), vec3f(1.5), pm / vec3f(4000.0, 1400.0, 500.0));
  let f1 = mix(0.25, cirrusRidge(streak), 1.0 - smoothstep(0.5, 1.5, pm / 12000.0));
  let f2 = mix(0.25, cirrusRidge(tnoise(kf2 * 2.0 + 3.0)), v.x);
  // (the finer ones soft streaky texture, not lines: as ridged lines along the streaks they were
  // scratches, and less stretched, a web of veins)
  let f3 = 0.25 + 0.6 * tnoise(kf2 * 6.0 + 9.0) * v.y;
  let f4 = 0.25 + 0.6 * tnoise(kf2 * 16.0 + 5.0) * v.z;
  let fib = 0.45 * f1 + 0.25 * f2 + 0.18 * f3 + 0.12 * f4;
  // (and where along a band it's thicker: swells tens of km long)
  let body = tnoise(kf * 0.3 + 29.0);
  // (a soft veil round the filaments: alone, the lines read as scratches on the view)
  let veil = smoothstep(-0.1, 0.25, body + 0.3 * streak);
  return area * max(smoothstep(0.15, 0.55, fib + 0.5 * body), 0.35 * veil) * 0.5;
}
fn cirrusRidge(n: f32) -> f32 {
  let r = max(1.0 - abs(n) * 3.5, 0.0);
  return r * r;
}

// how much sunlight reaches camera-relative point P (below the deck or in it) through the clouds
// above it (in the layer the march starts at P: it counted as clear there, and the ground under
// you brightened as you rose into the clouds)
fn sunThrough(P: vec3f, L: vec3f) -> f32 {
  let Cp = world.atC.xyz - P;
  let a = select(sphereSpan(L, Cp, rBot).y, 0.0, length(Cp) >= rBot);
  let b = sphereSpan(L, Cp, rTop + liftTop).y; // (the lifted top: from a point above the unlifted one it saw clear sky)
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
  rBot = world.radius + world.cloudH * cloudBaseK();
  rTop = world.radius + world.cloudH * 1.05;
  setLifts();
  // the segment of the ray inside the layer (the near one)
  let camR = length(C);
  let top = sphereSpan(dir, C, rTop + liftTop); // (the lifted layer's top: the march must reach it)
  let bot = sphereSpan(dir, C, rBot);
  var t0 = 0.0;
  var t1 = 0.0;
  if (camR < rBot) {
    t0 = bot.y;
    t1 = top.y;
  } else if (camR < rTop + liftCam) { // (the lifted layer's top: by the unlifted one, a camera just above it counted as above the layer and marched nothing)
    t0 = 0.0;
    t1 = select(top.y, bot.x, bot.y > bot.x && bot.x > 0.0);
  } else if (top.y > max(top.x, 0.0)) { // (above the layer here, but maybe under its top at most: from here)
    t0 = max(top.x, 0.0);
    t1 = select(top.y, bot.x, bot.y > bot.x && bot.x > 0.0);
  }
  // the scene in front ends it
  let d = textureLoad(sceneDepth, vec2i(full), 0);
  var sceneT = 1e30;
  if (d > 0.0) {
    let fwd = -normalize(frame.camRot[2].xyz);
    sceneT = vp.near / d / max(dot(dir, fwd), 1e-4);
    t1 = min(t1, sceneT);
  }
  let inLayer = camR >= rBot && camR < rTop + liftCam;
  let tNat = t1; // (where the ray leaves the layer or meets the scene, before the march's reach caps it)
  t1 = min(t1, t0 + select(MAX_DIST, MAX_DIST_IN, inLayer));
  let L = normalize(world.light.xyz);
  let j = fract(52.9829189 * fract(dot(vec2f(px) + vp.frameN * 5.588238, vec2f(0.06711056, 0.00583715))));
  // light shafts (below the deck, or in it): the haze along the ray, less where the clouds shade
  // the air (in the deck too: skipped there, the sea below brightened as you rose into the clouds;
  // it fades out toward the deck's top, where the view down is through the clouds themselves)
  var skyDim = 1.0;
  var rays = vec3f(0.0);
  if (camR < rTop + liftCam && world.atOn > 0.5) {
    // the air under the deck along the ray: to the ground or to the cloud base (toward the horizon
    // ~200 km); the shade is sampled over its first 30 km and taken for all of it (only the first
    // 30 km were dimmed, and the rest, reddened by its long path, glowed as a yellow band along the
    // horizon under overcast)
    var tFull = atSpan(dir).y;
    if (d > 0.0) { tFull = min(tFull, vp.near / d / max(dot(dir, -normalize(frame.camRot[2].xyz)), 1e-4)); }
    if (camR < rBot && bot.y > 0.0) { tFull = min(tFull, bot.y); }
    let tEnd = min(tFull, 30000.0);
    var shade = 0.0;
    var wsum = 0.0;
    for (var i = 0; i < 12; i++) {
      let P = dir * (tEnd * (f32(i) + j) / 12.0);
      let w = atDens(length(P - C));
      shade += (1.0 - sunThrough(P, L)) * w;
      wsum += w;
    }
    // the god rays: sunlight scattered forward by the haze's particles (Mie; white to golden, not
    // the air's blue) in the lit stretches of the first 30 km, where the clouds shade some of the
    // air (so the shafts stand out; a clear sky is left as it is: the sky shader has no Mie haze)
    let sf = shade / max(wsum, 1e-6);
    let litM = (wsum - shade) * tEnd / 12.0; // lit air along the ray, m at ground density
    let gate = smoothstep(0.1, 0.4, sf);
    let sunT = atSunlight(vec3f(0.0), L) * sunShade(-C);
    rays = min(sunT * (world.atSunI * MIE_B * litM * hg(dot(dir, L), 0.7) / 12.566) * gate, vec3f(3.0));
    // (none in a giant: its layer has no clear air under it, only the gap between its decks, and the
    // shade toward the sun, taken over a few km, missed the deck above: deep in it, looking up toward
    // the sun was a blinding white patch)
    if (cloudKind() == CK_GIANT) { rays = vec3f(0.0); }
    // a pair's second sun's shafts too (docs/binaries.md), from 6 samples (it's the dimmer one; the
    // shafts are soft)
    if (world.light2.w > 0.5) {
      let L2r = normalize(world.light2.xyz);
      var shade2 = 0.0;
      var wsum2 = 0.0;
      for (var i = 0; i < 6; i++) {
        let P = dir * (tEnd * (f32(i) + j) / 6.0);
        let w = atDens(length(P - C));
        shade2 += (1.0 - sunThrough(P, L2r)) * w;
        wsum2 += w;
      }
      let lit2 = (wsum2 - shade2) * tEnd / 6.0;
      let gate2 = smoothstep(0.1, 0.4, shade2 / max(wsum2, 1e-6));
      let sunT2 = atSunlight(vec3f(0.0), L2r) * world.lightC2.rgb;
      rays += min(sunT2 * (world.atSunI * MIE_B * lit2 * hg(dot(dir, L2r), 0.7) / 12.566) * gate2, vec3f(3.0));
    }
    // what's behind (sky or ground) is dimmed by that share as a whole: taking the stretch's haze off
    // instead left a reddish line on the horizon (the haze is compressed over a knee, atmo.wgsl
    // atRolloff), and the ground is dimmed evenly too (its ambient light and the sea's sky
    // reflection aren't shaded by the clouds in its own shader; faded in with distance, the ground
    // near you stood in a lighter circle)
    // (a fifth left: an overcast day, not night; and only by day: at night there's no sunlight for
    // the clouds to take away, and it darkened the night's own glow to nothing)
    let camDay = smoothstep(-0.1, 0.1, dot(normalize(-C), L));
    // (a surface: its own cloud shadow, where the sun's ray from it crosses the clouds; by the air's
    // shade along the line of sight, shadow columns crossing it painted the ground and the sea in dark
    // streaks running to the point opposite the sun. The sky keeps the air's.)
    let airShare = shade / max(wsum, 1e-6);
    var dimShare = airShare;
    var dimK = 0.8;
    // (fading out 20–60 km away, where what you see is mostly the air's haze over it: there it dimmed
    // the haze too, dark dashes along the horizon)
    // (a lone cloud's shadow keeps the blue sky's light: ~45 % left under it on a clear day, down to a
    // fifth as the sky clouds over; by the air's shade along the ray, how overcast it is)
    if (sceneT < 1e29) {
      dimShare = (1.0 - sunThrough(dir * sceneT, L)) * (1.0 - smoothstep(20000.0, 60000.0, sceneT));
      dimK = mix(0.55, 0.8, airShare);
    }
    skyDim = 1.0 - dimK * camDay * dimShare;
    let fade = smoothstep(mix(rBot, rTop, 0.6) + liftCam, rTop + liftCam, camR);
    skyDim = mix(skyDim, 1.0, fade);
    rays *= 1.0 - fade;
  }
  let cosT = dot(dir, L);
  let mid = dir * (0.5 * (t0 + t1)) - C;
  let sunCol = atSunlightC(normalize(mid) * (world.radius + world.cloudH), L) * sunShade(mid) * world.atSunI / 45.0;
  let dayK = smoothstep(-0.15, 0.3, dot(normalize(mid), L));
  // what the clouds are made of: their colour (a giant's, its bands' where this ray's clouds are,
  // giant.wgsl: from above they carry on its painted face)
  var cloudCol = world.cloudC.rgb;
  if (cloudKind() == CK_GIANT) { cloudCol = giantColAt(toLocalM() * normalize(mid)); }
  let sunUp = smoothstep(-0.15, 0.0, dot(normalize(mid), L));
  // (twilight's light from the sky over them, atmo.wgsl atTwilight: blue-hour clouds aren't black)
  let twL = atTwilight(normalize(mid), L, normalize(mid)) * 2.0;
  // (cities' light from below at night, clouds.wgsl cityGlowAt: taken once, at the ray's middle,
  // stronger low in the cloud)
  let cityL = cityGlowAt(toLocalM() * normalize(mid), L, normalize(mid)) * 2.0;
  // a pair's second sun (docs/binaries.md): its light through the air in its colour, a cheaper march
  // toward it (3 steps), the same scattering (its god rays above)
  let two = world.light2.w > 0.5;
  let L2 = normalize(world.light2.xyz + vec3f(0.0, 1e-9, 0.0));
  let cosT2 = dot(dir, L2);
  var sunCol2 = vec3f(0.0);
  if (two) { sunCol2 = atSunlightC(normalize(mid) * (world.radius + world.cloudH), L2) * sunShade2(mid) * world.lightC2.rgb * world.atSunI / 45.0 * smoothstep(-0.15, 0.3, dot(normalize(mid), L2)); }
  let span = t1 - t0;
  // Level of detail: steps no finer than 0.4 % of the distance to the layer (150 m at least), so a
  // ray from high up through a few km of layer takes ~12, not 48: from 300 km a screen full of
  // clouds cost so much that the dynamic resolution dropped to half. (A ray that misses the layer
  // marches nothing, but still goes through the blend below.)
  let steps = select(0, i32(f32(clamp(i32(ceil(2.0 * span / max(150.0, 0.004 * t0))), 12, select(STEPS, STEPS_IN, inLayer))) * vp.quality), t1 > t0);
  let sunSteps = select(SUN_STEPS, 3, t0 > 50000.0);
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
    let u = (f32(i) + j) / f32(steps);
    let t = t0 + span * u * u;
    let dt = span * 2.0 * max(u, 0.5 / f32(steps)) / f32(steps);
    let P = dir * t;
    // (fading out over the last fifth of the march's reach, where the flat deck fades in to carry on:
    // cut off, the clouds ended in a line across the view that moved with height and pitch)
    let dn = density(P) * select(1.0 - smoothstep(t0 + 0.8 * MAX_DIST, t0 + MAX_DIST, t), 1.0, inLayer);
    if (dn <= 0.0) { continue; }
    if (tFirst < 0.0) { tFirst = t; }
    // sunlight reaching here through the cloud toward the sun, taken where this step's light comes
    // from: its first ~1/(density × SIGMA) metres (~250 m), not its middle. From orbit the steps are
    // over a km long, and lit from deep inside them the tops of thick cloud were grey
    let Ps = dir * max(t0, t - 0.5 * dt + min(0.5 * dt, 1.0 / (dn * SIGMA)));
    var od = 0.0;
    var ls = 120.0;
    var lt = 0.0;
    for (var k = 0; k < sunSteps; k++) {
      lt += ls;
      od += density(Ps + L * lt) * ls;
      ls *= 2.0;
    }
    // light scattered many times inside the cloud (Frostbite's approximation: octaves each less
    // attenuated, weaker and less forward): clouds are bright from every side, not just sunward
    var sun = 0.0;
    var a = 1.0;
    var bw = 1.0;
    var g = 0.65;
    for (var o = 0; o < 3; o++) {
      sun += bw * exp(-od * SIGMA * a) * mix(hg(cosT, g), hg(cosT, -0.3 * g), BACK);
      a *= 0.35;
      bw *= 0.5;
      g *= 0.5;
    }
    let h = clamp((length(P - C) - liftAt(P) - rBot) / (rTop - rBot), 0.0, 1.0);
    // plus, near you, your own lamps scattered in the cloud (the path from them is the path from the
    // camera: × T again), and at night the night's own faint light
    let lamp = vec3f(1.0, 0.97, 0.92) * shipLightAt(P) * T * 0.08;
    // (lightning, inside a storm: clouds.wgsl flashAt, in the weather's frame)
    // (by day a quarter as bright against the sunlit cloud: from orbit, blazing white blobs on it)
    // (a strike near you, sim/lightning.ts: the cloud round where it leaves the base lit from
    // inside, and all of it by its light)
    var strikeC = vec3f(0.0);
    if (frame.strike.w > 0.0) {
      let dT = P - frame.strikeTop.xyz;
      strikeC = STRIKE_C * (frame.strike.w * 1.2 * exp(-dot(dT, dT) / (2500.0 * 2500.0)) + strikeLight(P, normalize(frame.strike.xyz - P)) * 0.15);
    }
    let flash = vec3f(0.75, 0.82, 1.0) * flashAt(cloudDir(toLocalM() * (P - C)), world.radius + world.cloudH * 0.7) * (1.0 - 0.75 * dayK);
    // (the sunlight's share in the shadows of what's near: a sky station's on the clouds under it)
    sun *= shadowAtPoint(P);
    // (the sun's own light isn't dimmed by dayK: sunCol already fades and reddens as it sets, and
    // dimmed twice, clouds at sunset were dull grey instead of glowing; only the sky's light is)
    // (the light diffused through the cloud, which is all its underside gets: 0.2 at the base. At
    // 0.05 an overcast's base was near black from under it, where it's a mid grey)
    var light = sunCol * (sun * 0.6 * sunUp + 0.2 * (0.55 + 0.45 * h) * dayK) * 0.97 + twL * (0.6 + 0.4 * h) + cityL * (1.0 - 0.7 * h) + lamp + flash + strikeC + vec3f(0.55, 0.7, 1.0) * 0.05 * (1.0 - dayK);
    if (two) {
      var od2 = 0.0;
      var ls2 = 240.0;
      var lt2 = 0.0;
      for (var k = 0; k < 3; k++) {
        lt2 += ls2;
        od2 += density(Ps + L2 * lt2) * ls2;
        ls2 *= 3.0;
      }
      var sun2 = 0.0;
      var a2 = 1.0;
      var bw2 = 1.0;
      var g2 = 0.65;
      for (var o = 0; o < 3; o++) {
        sun2 += bw2 * exp(-od2 * SIGMA * a2) * mix(hg(cosT2, g2), hg(cosT2, -0.3 * g2), BACK);
        a2 *= 0.35;
        bw2 *= 0.5;
        g2 *= 0.5;
      }
      // (and the shadows of what's near from it, as the first sun's: a sky station's on the clouds)
      light += sunCol2 * (sun2 * 0.6 * shadowAtPoint2(P) + 0.12 * (0.4 + 0.6 * h)) * 0.97;
    }
    // (a giant's lower deck is under the upper one, 7 km of cloud the short march toward the sun
    // doesn't reach through: lit as if it weren't there, it was a bright flat floor. A tenth gets
    // down, diffused)
    if (cloudKind() == CK_GIANT) { light *= mix(0.1, 1.0, smoothstep(-0.79, -0.51, (length(P - C) - world.radius) / (world.cloudH * 4.0))); }
    let tStep = exp(-dn * SIGMA * dt);
    S += T * light * cloudCol * (1.0 - tStep); // (× what they're made of: dust is the sand's colour)
    tSum += t * T * (1.0 - tStep);
    wSum += T * (1.0 - tStep);
    T *= tStep;
    if (T < 0.01) { break; }
  }
  // inside the layer, past the march's reach (100 km) the layer goes on: by the cover over you, a
  // haze of the light the clouds marched so far showed (an e-fold every ~50 km under full cover).
  // Cut off there, the view cleared abruptly, a band along the horizon from inside the clouds
  if (inLayer && tNat > t1 + 1.0 && T > 0.01) {
    let covC = cloudCover(cloudMap(toLocalM() * normalize(-C)));
    // (only well inside it: near its top or base the rays skimming along it cross thin, shadowed
    // edges, and taken as the layer's colour they drew a dark band along the horizon)
    let hc = (camR - liftCam - rBot) / (rTop - rBot);
    // (and only from inside a cloud, where the view is fog anyway: from clear air between them, at
    // sunrise, its colour was a dark band over the lit clouds toward the horizon)
    let deep = smoothstep(0.05, 0.25, hc) * (1.0 - smoothstep(0.6, 0.85, hc)) * smoothstep(0.02, 0.2, density(vec3f(0.0)));
    let fk = (1.0 - exp(-min(tNat - t1, 300000.0) * covC * 2e-5)) * deep;
    let base = (sunCol * (0.45 * sunUp + 0.15 * dayK) + twL) * cloudCol;
    var meanC = base;
    if (T < 0.95) { meanC = max(S / (1.0 - T), base * 0.8); }
    S += T * fk * meanC;
    T *= 1.0 - fk;
  }
  // the air in front of the cloud: its haze and how much it dims
  if (tFirst > 0.0 && world.atOn > 0.5) {
    let span = atSpan(dir);
    var haze = atInscatter(dir * span.x, dir * max(tFirst, span.x), L, 4);
    if (two) { haze += atInscatter(dir * span.x, dir * max(tFirst, span.x), L2, 4) * world.lightC2.rgb; }
    S = S * atTrans + haze * (1.0 - T) * skyDim; // (under the deck, that air is shaded too)
  }
  var res = vec4f((S + rays) * frame.exposure, T * skyDim);
  // Under overcast (docs/clouds.md): below the cloud base, with thick cover overhead, the air is
  // moist and lit only by the light through the clouds: a grey, even fog, thickening with distance
  // (an e-fold every ~12 km), over everything in front of the scene or the cloud base. The air's own
  // blue haze stayed as on a clear day, and the far land sharp and blue under a grey ceiling.
  // (Taken from the cover over you; for 85 % of the ground behind at most: the far coast still shows.)
  // (fading out over the layer's lowest 2 km as you rise into it: cut off at the base, the view
  // changed at once there, from a grey murk to the clouds' own)
  // (dust has no base to be under, it rises from the ground: its murk is there up to half its depth,
  // fading out by two thirds; without it, from in a storm the clear sky past it showed as a bright
  // line along the horizon)
  var fogIn = 1.0 - smoothstep(rBot + liftCam - 500.0, rBot + liftCam + 2000.0, camR);
  if (cloudKind() == CK_DUST) { fogIn = 1.0 - smoothstep(mix(rBot, rTop, 0.45) + liftCam, mix(rBot, rTop, 0.7) + liftCam, camR); }
  if (world.atOn > 0.5 && fogIn > 0.0) {
    let upC = normalize(-C);
    let dust = cloudKind() == CK_DUST; // (its cover tops out at 0.9: thick from 0.3)
    let k = smoothstep(select(0.5, 0.3, dust), select(0.8, 0.7, dust), cloudCover(cloudMap(toLocalM() * upC))) * fogIn;
    if (k > 0.0) {
      var dF = min(sceneT, 200000.0);
      if (bot.y > 0.0 && camR < rBot) { dF = min(dF, bot.y); }
      // (up to 97 % 30–120 km off: at 85 % the sunlit land and sky beyond the overcast showed as a
      // bright line along the horizon)
      let amt = k * mix(0.85, 0.97, smoothstep(30000.0, 120000.0, dF)) * (1.0 - exp(-dF / 12000.0));
      // (its light: the sun's through the air at the cloud base, a fifth through the clouds, grey, by
      // day; twilight's at dusk; the night's faint glow)
      let sunB = atSunlightC(upC * (world.radius + world.cloudH * cloudBaseK()), L) * world.atSunI / 45.0;
      let lB = dot(sunB, vec3f(0.2126, 0.7152, 0.0722)) * smoothstep(-0.1, 0.2, dot(upC, L));
      // (in a dust storm, a brown murk: the dust's colour; under an acid deck, orange: the light's
      // reddened on its way down through tens of km of it, Venus's day. In the deck's own pale
      // yellow, over the dim ground, the murk was olive)
      let murk = select(world.cloudC.rgb * 0.72, vec3f(0.62, 0.66, 0.72), cloudKind() == CK_WATER) * select(vec3f(1.0), vec3f(1.0, 0.72, 0.42) * 1.3, cloudKind() == CK_ACID);
      let fogC = murk * (0.3 * lB + 0.004) + atTwilight(upC, L, upC);
      res = vec4f(res.rgb * (1.0 - amt) + fogC * amt * frame.exposure, res.a * (1.0 - amt));
    }
  }
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
        // (where last frame's differs a lot in what shows through, it was something else there, a
        // cloud's edge that's since moved across: this frame's counts for more, or it trailed ghosts)
        let hist = textureSampleLevel(history, histSamp, uv, 0.0);
        // (and where it's much brighter or darker than then, lightning came or went: blended, a flash
        // showed at once only where the view had turned past last frame's, a ghost the screen's shape)
        let lH = dot(hist.rgb, vec3f(0.2126, 0.7152, 0.0722));
        let lR = dot(res.rgb, vec3f(0.2126, 0.7152, 0.0722));
        // (brightening only, and sharply: a flash. Both ways, the march's own noise at cloud edges
        // dropped the history too, and the clouds shimmered)
        let jump = smoothstep(0.5, 0.8, (lR - lH) / (lR + 0.02));
        // (and where the reprojection is unsure: moving through the clouds, what this pixel shows is
        // spread over many distances, and taken at one, last frame's slid off where it was, ghosts
        // trailing as you flew through them. How far apart (march pixels) the same view lands for
        // half and twice that distance: the parallax that one distance can't account for)
        let qa = vp.prevVP * vec4f(dir * tr * 0.5 + vp.moved.xyz, 1.0);
        let qb = vp.prevVP * vec4f(dir * tr * 2.0 + vp.moved.xyz, 1.0);
        var unsure = 1.0;
        if (qa.w > 0.0 && qb.w > 0.0) {
          let par = length((qa.xy / qa.w - qb.xy / qb.w) * 0.5 * vp.size);
          unsure = smoothstep(0.75, 4.0, par);
        }
        res = mix(hist, res, max(max(mix(0.2, 0.6, smoothstep(0.25, 0.6, abs(hist.a - res.a))), jump), 0.85 * unsure));
      }
    }
  }
  textureStore(outTex, px, res);
}

// ---- Laying the result over the frame (vclouds.ts composite), at full resolution ----
// The march's result (bound as `history`: this frame's) upsampled depth-aware: a soft 3 × 3 over its
// half-res texels, each weighted by how alike the scene's depth is where it was marched and here
// (blurred across an edge, the far terrain's against the sky, sky clouds bled onto the ground and
// the ground's onto the sky). Then the cirrus, at this resolution (it's a thin sheet, one lookup),
// in front of the lower clouds from above them and behind them from below. The blend is
// frame × alpha + rgb.
@vertex
fn vsComposite(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return fullscreen(i); }

@fragment
fn fsComposite(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let full = vec2f(textureDimensions(sceneDepth));
  let half = vec2i(textureDimensions(history));
  let kk = full / vec2f(half);
  let dc = textureLoad(sceneDepth, vec2i(pos.xy), 0);
  let cc = pos.xy / kk - 0.5;
  let base = vec2i(floor(cc + 0.5));
  var sum = vec4f(0.0);
  var wsum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let tt = clamp(base + vec2i(x, y), vec2i(0), half - 1);
      let tp = (vec2f(tt) + 0.5) * kk;
      let dt = textureLoad(sceneDepth, vec2i(min(tp, full - 1.0)), 0);
      let g = (2.0 - f32(abs(x))) * (2.0 - f32(abs(y)));
      let same = exp(-abs(dt - dc) / (0.03 * max(dt, dc) + 1e-7));
      let w = g * (same + 1e-3);
      sum += textureLoad(history, tt, 0) * w;
      wsum += w;
    }
  }
  var cl = sum / wsum;
  // the cirrus
  let dir = viewDir(pos.xy);
  let C = world.atC.xyz;
  let camR = length(C);
  rBot = world.radius + world.cloudH * cloudBaseK();
  rTop = world.radius + world.cloudH * 1.05;
  setLifts();
  let L = normalize(world.light.xyz);
  let cosT = dot(dir, L);
  var sceneT = 1e30;
  if (dc > 0.0) { sceneT = vp.near / dc / max(dot(dir, -normalize(frame.camRot[2].xyz)), 1e-4); }
  let rCi = world.radius + world.cloudH * CIRRUS_H;
  let ciSpan = sphereSpan(dir, C, rCi);
  var tCi = -1.0;
  if (camR < rCi) { tCi = ciSpan.y; } else if (ciSpan.y > ciSpan.x && ciSpan.x > 0.0) { tCi = ciSpan.x; }
  if (tCi > 0.0 && tCi < sceneT && vp.on > 0.0 && cloudKind() == CK_WATER) { // (ice: water worlds only)
    let Q = dir * tCi - C;
    let up = normalize(Q);
    // (a pixel's footprint on the sheet, along the ray's slant through it: the long way, toward
    // the horizon. Its slant capped at 0.1, there the footprint was under a fifth of what it is, the
    // fine streaks never faded, and the cirrus was jagged, stepping from pixel row to row)
    let pm = tCi * 2.0 / (frame.proj.y * frame.viewport.y) / max(abs(dot(dir, up)), 0.01);
    let a0 = cirrus(cloudDir(toLocalM() * Q), pm);
    if (a0 > 0.0) {
      // (a thin sheet: seen edge-on, the path through it, and its opacity, grow)
      // (thinner once the sun's gone from it: unlit, over the twilit clouds and ground under it, it
      // drew dark stripes across them; in the night, faint ice is all but invisible)
      let a = (1.0 - pow(1.0 - a0, 1.0 / max(abs(dot(dir, up)), 0.12))) * vp.on * (0.15 + 0.85 * smoothstep(-0.15, 0.03, dot(up, normalize(world.light.xyz))));
      // lit white, brighter toward the sun (ice scatters forward), dimmed by the air in front, which
      // stays in front of it
      let sunC = atSunlightC(Q, L) * sunShade(Q) * world.atSunI / 45.0;
      // (lit by the sun as long as it reaches it, reddened by the air: at sunset the brightest thing
      // in the sky, as cirrus is; dimmed by the sun's height too, it was dark grey)
      let dayC = smoothstep(-0.1, 0.25, dot(up, L));
      var ci = sunC * (0.8 + 0.15 * hg(cosT, 0.6)) * smoothstep(-0.12, 0.0, dot(up, L)) + vec3f(0.03, 0.04, 0.06) * dayC + atTwilight(up, L, up) * 2.0;
      // (and a pair's second sun's light on it, in its colour)
      if (world.light2.w > 0.5) {
        let L2c = normalize(world.light2.xyz);
        ci += atSunlightC(Q, L2c) * world.lightC2.rgb * world.atSunI / 45.0 * (0.8 + 0.15 * hg(dot(dir, L2c), 0.6)) * smoothstep(-0.1, 0.25, dot(up, L2c));
      }
      if (world.atOn > 0.5) {
        let sp = atSpan(dir);
        let hz = atInscatter(dir * sp.x, dir * max(tCi, sp.x), L, 4);
        ci = ci * atTrans + hz;
      }
      ci *= frame.exposure;
      if (camR >= rTop + liftCam) {
        cl = vec4f(ci * a + (1.0 - a) * cl.rgb, (1.0 - a) * cl.a); // above the lower clouds: in front
      } else {
        cl = vec4f(cl.rgb + cl.a * ci * a, cl.a * (1.0 - a)); // under or in them: behind
      }
    }
  }
  return cl;
}
