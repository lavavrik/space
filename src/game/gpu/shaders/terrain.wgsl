// Terrain height (render/shaders/terrain.glsl; sim/terrain.ts is the CPU twin and docs/terrain.md
// has the why): continents (fBm), mountain ranges (ridged noise inside ranges marked by octave 2),
// craters on moons. The GLSL's out parameters and globals are private variables here.
const T_OCT_MAX: i32 = 17;
const TERR_GAIN: f32 = 0.55;
const MTN_FROM: i32 = 3;
const MTN_GAIN: f32 = 0.55;
const MTN_K: f32 = 1.3;
const MTN_MEAN: f32 = 0.3;
const FINE_FROM: i32 = 8;
const FINE_GAIN: f32 = 0.68;
const CRATER_FROM: i32 = 3;
const CRATER_TO: i32 = 13;
const CRATER_P: f32 = 0.5;

var<private> tDet: f32;       // albedo detail from octaves 6+
var<private> tMask: f32;      // the mountain-range mask terrH found
var<private> tCoarse: f32;    // terrH's h with only the first `split` octaves
var<private> tOffDir: vec3f;  // the point's direction minus the chunk centre's (terrain chunks)
var<private> tUseOff: bool = false;
// a pixel's footprint (unit-direction units; terrHFrom): the noise's own 8-tap filter only where a
// texel spans a few pixels (where the GPU's 8-bit filter weights would show as blocks), the GPU's
// one-tap filter below that. All 8 taps on every octave: ~80 texture reads a pixel zoomed in, the
// terrain's whole cost at 100×. 0: always the 8-tap one.
var<private> tFw: f32 = 0.0;

fn terrQ(d: vec3f, i: i32, k: f32) -> vec3f {
  if (tUseOff) { return chunk.qn[i].xyz + tOffDir * k; }
  return d * k + world.tOff[i].xyz;
}
fn terrQC(d: vec3f, i: i32, k: f32) -> vec3f {
  if (tUseOff) { return chunk.qc[i].xyz + tOffDir * k; }
  return d * k + world.tOff[i].xyz;
}

// integer hashing exact in float32 and double (sim/terrain.ts), so both sides agree on craters
fn mod289i(x: f32) -> f32 { return x - floor((x + 0.5) * (1.0 / 289.0)) * 289.0; }
fn perm289(x: f32) -> f32 { return mod289i((x * 34.0 + 1.0) * x); }

fn craters(q: vec3f, k: f32) -> f32 {
  let base = floor(q - 0.5);
  var acc = 0.0;
  for (var n = 0; n < 8; n++) {
    let c = base + vec3f(f32(n & 1), f32((n >> 1u) & 1), f32(n >> 2u));
    let h = perm289(perm289(perm289(mod289i(c.z) + 7.0) + mod289i(c.y)) + mod289i(c.x));
    if (perm289(h + 5.0) / 289.0 > CRATER_P) { continue; }
    let cen = c + vec3f(perm289(h + 1.0), perm289(h + 2.0), perm289(h + 3.0)) / 289.0;
    let r = 0.12 + 0.23 * perm289(h + 4.0) / 289.0;
    let x = length(q - cen) / r;
    if (x > 1.4) { continue; }
    let rho = r * world.radius / k;
    let depth = rho * 0.4 * min(1.0, sqrt(4000.0 / rho));
    let bowl = select(0.0, max(x * x - 1.0, -0.85), x < 1.0);
    let prof = bowl + 0.3 * exp(-((x - 1.0) / 0.22) * ((x - 1.0) / 0.22));
    acc += prof * depth / world.terrA;
    tDet += select(0.0, -0.6, x < 1.0) + 2.0 * exp(-((x - 1.0) / 0.15) * ((x - 1.0) / 0.15));
  }
  return acc;
}

// h at unit direction d with `oct` octaves; tCoarse gets h with only the first `split`
fn terrH(d: vec3f, oct: i32, split: i32) -> f32 {
  var a = 0.5;
  var s = 0.0;
  var k = 1.6;
  var am = 0.5;
  var r = 0.0;
  var w = 1.0;
  var mask = 0.0;
  var cr = 0.0;
  tCoarse = 0.0;
  tDet = 0.0;
  for (var i = 0; i < T_OCT_MAX; i++) {
    if (i >= oct) { break; }
    if (i == split) { tCoarse = s + mask * (r - MTN_MEAN) * MTN_K + cr; }
    let q = terrQ(d, i, k);
    var n: f32;
    if (i < FBM_EXACT) { n = snoise(q); } else { n = tnoise(q); }
    s += a * n;
    if (i >= 6) { tDet = tDet * 0.8 + n; }
    if (i == 2) { mask = smoothstep(-0.05, 0.45, n); }
    if (i >= MTN_FROM) {
      var rn = 1.0 - abs(n);
      rn *= rn;
      r += am * rn * w;
      w = clamp(rn * 1.4, 0.25, 1.0);
      am *= select(MTN_GAIN, FINE_GAIN, i >= FINE_FROM);
    }
    if (world.craters > 0.5 && i >= CRATER_FROM && i <= CRATER_TO && (i & 1) == 1) { cr += craters(terrQC(d, i, k), k); }
    k *= 2.03;
    a *= select(TERR_GAIN, FINE_GAIN, i >= FINE_FROM);
  }
  let h = s + mask * (r - MTN_MEAN) * MTN_K + cr;
  if (split >= oct) { tCoarse = h; }
  tMask = mask;
  return h;
}

fn octA(i: i32) -> f32 { return 0.5 * pow(TERR_GAIN, f32(min(i, FINE_FROM))) * pow(FINE_GAIN, f32(max(i - FINE_FROM, 0))); }
fn octAm(i: i32) -> f32 { return 0.5 * pow(MTN_GAIN, f32(min(i, FINE_FROM) - MTN_FROM)) * pow(FINE_GAIN, f32(max(i - FINE_FROM, 0))); }

// The most octaves o0…oct can raise h by (each fBm octave's ±amplitude, a little over for simplex's
// overshoot, and the ridges' full height): with hc + this under the sea, the point is sea whatever
// they add (planet.wgsl skips them: zoomed in on the sea, every pixel ran all 17 for nothing)
fn terrRise(o0: i32, oct: i32) -> f32 {
  var s = 0.0;
  for (var i = 0; i < T_OCT_MAX; i++) {
    if (i < o0) { continue; }
    if (i >= oct) { break; }
    s += octA(i) * 1.15;
    if (i >= MTN_FROM) { s += octAm(i) * MTN_K; }
  }
  return s;
}

// terrH's octaves from…oct only, added to hc (baked per vertex), with the range mask found there
fn terrHFrom(d: vec3f, o0: i32, oct: i32, hc: f32, mask0: f32) -> f32 {
  var s = 0.0;
  var r = 0.0;
  var w = 0.6;
  var cr = 0.0;
  var mask = mask0;
  var k = 1.6 * pow(2.03, f32(o0));
  if (o0 <= MTN_FROM) { w = 1.0; }
  tDet = 0.0;
  for (var i = 0; i < T_OCT_MAX; i++) {
    if (i < o0) { continue; }
    if (i >= oct) { break; }
    let q = terrQ(d, i, k);
    var n: f32;
    // (a noise texel here: 1 / (8k) in direction units; magnified past ~3 px, the precise filter)
    if (i < FBM_EXACT) { n = snoise(q); } else if (tFw <= 0.0 || 1.0 / (8.0 * k * tFw) > 3.0) { n = tnoiseHQ(q); } else { n = tnoise(q); }
    s += octA(i) * n;
    if (i >= 6) { tDet = tDet * 0.8 + n; }
    if (i == 2) { mask = smoothstep(-0.05, 0.45, n); }
    if (i >= MTN_FROM) {
      var rn = 1.0 - abs(n);
      rn *= rn;
      r += octAm(i) * rn * w;
      w = clamp(rn * 1.4, 0.25, 1.0);
    }
    if (world.craters > 0.5 && i >= CRATER_FROM && i <= CRATER_TO && (i & 1) == 1) { cr += craters(terrQC(d, i, k), k); }
    k *= 2.03;
  }
  return hc + s + mask * (r - select(0.0, MTN_MEAN, o0 <= 2)) * MTN_K + cr;
}

fn terrElev(h: f32, sea: f32, seaOn: bool) -> f32 { return world.terrA * select(h, max(h - sea, 0.0), seaOn); }

// Ground colour's large-scale terms (planet.wgsl): hundreds of km across, so a chunk's vertices carry
// them (terrainBake.wgsl) and its pixels interpolate, instead of each running the simplex noise.
//   h2 base: the first FBM_EXACT octaves of the colour patches' fBm; moist: the two big octaves of the
//   land's moisture (landMoist adds the finer one per pixel)
const H2_SEED: i32 = 3; // (= FBM_EXACT)
fn h2At(p: vec3f, seed: f32) -> vec3f { return p * 1.6 * 3.1 + vec3f(seed * 1.7, seed * 2.3, seed * 0.9) * 3.1 + 4.0; }
fn moist12(p: vec3f, seed: f32) -> f32 {
  return 0.5 + 0.35 * snoise(p * 2.6 + vec3f(seed * 1.9, 7.0, seed)) + 0.2 * snoise(p * 11.0 + vec3f(2.0, seed, 5.0));
}
fn h2Base(p: vec3f, seed: f32) -> f32 { return fbmF(h2At(p, seed), H2_SEED); }
