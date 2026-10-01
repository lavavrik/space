// City lights on the night side of populated worlds (render/shaders/cityLights.glsl has the design
// notes; sim/population.ts mirrors cityPop: keep them in step). cityWhite is cityLights' second result.
var<private> cityWhite: f32;

fn cityPcg(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

fn cityHash(c: vec3f, salt: f32) -> vec3f {
  let u = vec3u(vec3i(c) + vec3i(1 << 20u)) + vec3u(u32(salt), u32(world.seed * 1000.0), 0u);
  return vec3f(cityPcg(u)) * (1.0 / 4294967295.0);
}

fn cityPop(p: vec3f, e: f32, lat: f32) -> f32 {
  if (e <= 0.002) { return 0.0; }
  let s = world.seed;
  let land = sm(0.002, 0.01, e) * sm(0.42, 0.18, e);
  let coast = 1.0 + 1.6 * sm(0.08, 0.0, e);
  let temperate = sm(0.82, 0.55, lat);
  let region = sm(-0.25, 0.45, snoise(p * 2.3 + vec3f(s * 3.1, 11.0, s)));
  let rural = 0.55 + 0.45 * sm(-0.3, 0.6, snoise(p * 9.0 + vec3f(5.0, s, 2.0)));
  return clamp(land * coast * temperate * region * rural, 0.0, 1.0);
}

fn citySpots(q: vec2f, salt: f32, P: f32, r0: f32, rk: f32, k: f32, dmax: f32) -> f32 {
  let c0 = floor(q);
  var sum = 0.0;
  for (var j = 0; j < 9; j++) {
    let c = c0 + vec2f(f32(j % 3 - 1), f32(j / 3 - 1));
    let h = cityHash(vec3f(c, salt), 0.0);
    if (h.x > P) { continue; }
    let h2 = cityHash(vec3f(c, salt), 31.0);
    let d = length(q - c - h2.xy) / (r0 * pow(rk, h.y));
    if (d < dmax) { sum += (0.3 + 1.4 * h.z) * exp(-k * d * d) * sm(dmax, 0.7 * dmax, d); }
  }
  return sum;
}

fn cityRes(f: f32, fw: f32) -> f32 { return clamp((1.0 / (f * fw) - 1.0) / 3.0, 0.0, 1.0); }

// The built-up city, shared by its lights at night and its look by day (cityDay), so the lit city is
// the built city: the urban intensity (a fBm of the population, its broad cores), the cities and towns
// on it (blobs, 4 sizes) and the districts in them (specks). `L`: its density (~0…3); `sp`: the noise
// frame; `uv`, `face`: the cube-face frame the spots and street grid are laid out in.
struct CityD {
  L: f32,
  sp: vec3f,
  uv: vec2f,
  face: f32,
}
// the frames a city's laid out in at p (its noise's; the cube face's and the point on it), with the
// density L given (baked per vertex on terrain chunks, terrainBake.wgsl)
fn cityFrame(p: vec3f, L: f32) -> CityD {
  let sp = p + vec3f(world.seed * 0.37, 3.1, world.seed * 0.21);
  let a = abs(p);
  var face: f32;
  var uv: vec2f;
  if (a.x >= a.y && a.x >= a.z) { face = select(1.0, 0.0, p.x > 0.0); uv = p.yz / a.x; }
  else if (a.y >= a.z) { face = select(3.0, 2.0, p.y > 0.0); uv = p.xz / a.y; }
  else { face = select(5.0, 4.0, p.z > 0.0); uv = p.xy / a.z; }
  return CityD(L, sp, uv, face);
}

fn cityDensity(p: vec3f, pop: f32, fw: f32) -> CityD {
  let sp = p + vec3f(world.seed * 0.37, 3.1, world.seed * 0.21);
  var n = 0.0;
  var amp = 0.5;
  var f = 25.0;
  for (var i = 0; i < 10; i++) {
    let k = clamp(1.5 - 2.0 * f * fw, 0.0, 1.0);
    if (k <= 0.0) { break; }
    n += amp * k * snoise(sp * f + f32(i) * 1.7);
    amp *= 0.6;
    f *= 2.0;
  }
  let I = sm(0.4, 1.0, pop * 0.9 + 0.5 * n);
  var L = 0.7 * I + 0.12 * pop;
  let fr = cityFrame(p, 0.0);
  let uv = fr.uv;
  let face = fr.face;
  var s = 30.0;
  let Pc = mix(0.2, 0.6, pop);
  for (var i = 0; i < 4; i++) {
    let res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let g = 0.15 + 0.85 * citySpots(uv * s * 0.5, face * 16.0 + f32(i), Pc, 0.2, 3.5, 2.5, 1.6) * 4.47 / Pc;
    L *= mix(1.0, select(g, pow(g, 0.75) / (0.63 + 0.29 * Pc), i == 0), res);
    s *= 4.0;
  }
  return CityD(L, sp, uv, face);
}

fn cityLights(p: vec3f, pop: f32, fw: f32) -> f32 {
  cityWhite = 0.0;
  if (pop <= 0.0) { return 0.0; }
  return cityLightsOf(cityDensity(p, pop, fw), pop, fw);
}
// …from the city's density and frames (on terrain chunks, baked: cityFrame)
fn cityLightsOf(cd: CityD, pop: f32, fw: f32) -> f32 {
  cityWhite = 0.0;
  if (pop <= 0.0) { return 0.0; }
  var L = cd.L;
  let sp = cd.sp;
  let uv = cd.uv;
  let face = cd.face;
  var s = 30.0;
  var f = 300.0;
  for (var i = 0; i < 3; i++) {
    let res = cityRes(2.0 * f, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let t = max(0.0, 1.0 - abs(snoise(sp * f + f32(i) * 31.7)));
    L *= mix(1.0, 0.4 + 0.6 * pow(t, 5.0) / 0.293, res);
    f *= 3.0;
  }
  s = 30.0 * 64.0;
  for (var i = 0; i < 4; i++) {
    let res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let g = 0.2 + 169.7 * citySpots(uv * s * 0.5, face * 16.0 + f32(i) + 100.0, 0.7, 0.06, 2.667, 5.0, 1.0);
    L *= mix(1.0, pow(g, 0.75) / 0.576, res);
    s *= 4.0;
  }
  let F = 40000.0;
  let res = cityRes(F, fw);
  if (res > 0.0 && L > 0.0) {
    let ang = cityHash(vec3f(floor(uv * F / 12.0), face), 55.0).x * 1.5708;
    let r = mat2x2f(cos(ang), sin(ang), -sin(ang), cos(ang)) * uv * F;
    let t = abs(fract(r) - 0.5);
    let lines = max(1.0 - smoothstep(0.0, 0.08, t.x), 1.0 - smoothstep(0.0, 0.08, t.y));
    let lamps = 0.4 + 0.6 * (0.5 + 0.5 * cos(r.x * 18.85)) * (0.5 + 0.5 * cos(r.y * 18.85));
    L *= mix(1.0, (0.08 + lines * lamps) / 0.165, res);
  }
  cityWhite = sm(1.5, 4.0, L);
  s = 30.0 * 64.0;
  for (var i = 0; i < 4; i++) {
    let res2 = cityRes(s, fw);
    if (res2 <= 0.0) { break; }
    let q = uv * s * 0.5;
    let c = floor(q);
    let h = cityHash(vec3f(c, face * 16.0 + f32(i) + 700.0), 0.0);
    if (h.x < 0.08 * pop) {
      let h2 = cityHash(vec3f(c, face * 16.0 + f32(i) + 700.0), 31.0);
      let d = length(q - c - 0.3 - 0.4 * h2.xy) / 0.05;
      L += res2 * (1.0 - cityRes(4.0 * s, fw)) * exp(-4.0 * d * d) * 0.9;
    }
    s *= 4.0;
  }
  L *= 1.8;
  return 1.3 * L / (1.0 + L);
}

// ---- By day (docs/terrain.md "Cities by day") ----
// What's built where the lights are, on terrain chunks: the towns' density (baked per vertex) as
// cover, and the villages the districts' specks scatter round them, the fabric toned by district
// (grey, beige, some terracotta). As far as they're resolved, the lights' own street grid (~126 m
// blocks, each district turned its own way) as streets between blocks of roofs, each block built or
// not by the density at its middle (so towns end raggedly, a block at a time), with parks, and the
// highways the lights follow at night as dark lines. Nothing's modelled in 3D: the airspace over the
// cities is closed below ~3 km (sim/airspace.ts), where this reads as a city.
struct CityLook {
  col: vec3f,
  cover: f32,
}
// how the baked density changes across the screen, to carry it to a block's middle: its and the
// point's (camera-relative, m) screen derivatives, and the world's turn (object → world axes)
struct CityLin {
  dLx: f32,
  dLy: f32,
  dWx: vec3f,
  dWy: vec3f,
  toWorld: mat3x3f,
}
const CITY_ASPHALT: vec3f = vec3f(0.16, 0.16, 0.17);
// the towns' density where their cover starts and where it's full (sim/airspace.ts: its floor rises
// just outside the first)
const CITY_C0: f32 = 0.08;
const CITY_C1: f32 = 0.35;

// the districts' specks at uv (the lights' factor on the density: ~0.07 away from one, more on one).
// By day only the two coarse layers: the finer two are spots under a block (~50 m and less), which
// can't make a block built or not, at 18 hashes a layer
fn citySpecks(uv: vec2f, face: f32, fw: f32) -> f32 {
  var k = 1.0;
  var s = 30.0 * 64.0;
  for (var i = 0; i < 2; i++) {
    let res = cityRes(s, fw);
    if (res <= 0.0) { break; }
    let g = 0.2 + 169.7 * citySpots(uv * s * 0.5, face * 16.0 + f32(i) + 100.0, 0.7, 0.06, 2.667, 5.0, 1.0);
    k *= mix(1.0, pow(g, 0.75) / 0.576, res);
    s *= 4.0;
  }
  return k;
}
// the built-up share: the towns (their density), and the villages round them (the density with the
// specks, as the lights have it: by that alone the cities were scattered dots by day)
fn cityCover(L: f32, specks: f32) -> f32 { return max(sm(CITY_C0, CITY_C1, L), 0.9 * sm(0.03, 0.4, L * specks)); }
// (…the specks only looked up where they could make a village: the two layers multiply the density
// by at most ~50)
fn cityCoverAt(L: f32, uv: vec2f, face: f32, fw: f32) -> f32 {
  if (L < 6e-4) { return 0.0; }
  return cityCover(L, citySpecks(uv, face, fw));
}

// a cube face's point uv back to a unit direction (cityFrame's face and uv)
fn cityFaceDir(face: f32, uv: vec2f) -> vec3f {
  let f = i32(face + 0.5);
  let sg = select(1.0, -1.0, (f & 1) == 1);
  if (f < 2) { return normalize(vec3f(sg, uv.x, uv.y)); }
  if (f < 4) { return normalize(vec3f(uv.x, sg, uv.y)); }
  return normalize(vec3f(uv.x, uv.y, sg));
}

fn cityDay(cd: CityD, p: vec3f, pop: f32, fw: f32, ground: vec3f, lin: CityLin) -> CityLook {
  if (pop <= 0.0 || cd.L <= 0.0) { return CityLook(ground, 0.0); }
  let uv = cd.uv;
  let face = cd.face;
  let F = 40000.0;
  let res = cityRes(F, fw);
  // (the share at this pixel: where the blocks aren't resolved, and blending into them)
  var cover = 0.0;
  if (res < 0.99) { cover = cityCoverAt(cd.L, uv, face, fw); }
  // highways (the lights' roads), out into the country between the towns too
  var road = 0.0;
  if (cd.L > 0.01) {
    // (the lights' two coarser octaves: ~25 and 8 km between turns)
    var f = 300.0;
    for (var i = 0; i < 2; i++) {
      let rr = cityRes(2.0 * f, fw);
      if (rr <= 0.0) { break; }
      let t = 1.0 - abs(snoise(cd.sp * f + f32(i) * 31.7));
      road = max(road, sm(0.985, 0.997, t) * rr * sm(0.04, 0.25, cd.L));
      f *= 3.0;
    }
  }
  // the district's tone (its blocks of 12 × 12, as the lights' street grid turns)
  let dc = floor(uv * F / 12.0);
  let dh = cityHash(vec3f(dc, face), 55.0);
  let dh2 = cityHash(vec3f(dc, face), 91.0);
  // (warm: concrete, brick, roofs; a neutral grey read lavender under the haze)
  // (and some districts of red tile, not many: more, and a city's patch went pink under the haze)
  var fabric = mix(vec3f(0.46, 0.45, 0.42), vec3f(0.57, 0.53, 0.46), dh2.x);
  fabric = mix(fabric, vec3f(0.56, 0.40, 0.32), select(0.0, 0.35, dh2.y < 0.15));
  // (from afar: roofs, streets and their shadows together)
  var col = fabric * 0.82;
  var built = cover;
  if (res > 0.0) {
    let ang = dh.x * 1.5708;
    let r = mat2x2f(cos(ang), sin(ang), -sin(ang), cos(ang)) * uv * F;
    // (the streets run where the lights' street lamps are, through the grid's cell centres: a block
    // is the square between four of them)
    let cell = floor(r + 0.5);
    // the block's middle: the density there, carried from this pixel by its screen derivatives
    // (linear across a triangle, as it's interpolated), and the specks there
    let uvc = mat2x2f(cos(ang), -sin(ang), sin(ang), cos(ang)) * cell / F;
    let dw = lin.toWorld * (cityFaceDir(face, uvc) - p) * world.radius;
    let a11 = dot(lin.dWx, lin.dWx);
    let a12 = dot(lin.dWx, lin.dWy);
    let a22 = dot(lin.dWy, lin.dWy);
    let det = a11 * a22 - a12 * a12;
    var Lc = cd.L;
    if (abs(det) > 1e-12) {
      let b1 = dot(lin.dWx, dw);
      let b2 = dot(lin.dWy, dw);
      Lc = max(cd.L + ((a22 * b1 - a12 * b2) * lin.dLx + (a11 * b2 - a12 * b1) * lin.dLy) / det, 0.0);
    }
    let coverB = cityCoverAt(Lc, uvc, face, fw);
    let hb = cityHash(vec3f(cell, face), 77.0);
    var roof = fabric * (0.72 + 0.56 * hb.x);
    if (hb.y < 0.12) { roof = vec3f(0.22, 0.22, 0.23); } // (dark roofs, flat tar)
    if (hb.y > 0.93) { roof = vec3f(0.74, 0.74, 0.72); } // (white ones, sheds and malls)
    // parks: more where it's less built up
    if (hb.z < 0.04 + 0.22 * (1.0 - coverB)) { roof = ground * vec3f(0.85, 1.05, 0.8); }
    let t = min(abs(fract(r) - 0.5).x, abs(fract(r) - 0.5).y); // (to the nearest street, in blocks)
    let street = 1.0 - smoothstep(0.05, 0.08, t); // (~13 m of a ~126 m block)
    // (each block a little darker along its streets: its buildings' shadows and walls)
    let edge = (1.0 - smoothstep(0.08, 0.16, t)) * (1.0 - street);
    col = mix(col, mix(roof * (1.0 - 0.25 * edge), CITY_ASPHALT, street), res);
    // block by block: built or not, as likely as the density at its middle (a town's edge ragged by
    // its blocks; by the density at each pixel every town and village was a disc cut out of the grid)
    let hb2 = cityHash(vec3f(cell, face), 78.0);
    built = mix(cover, select(0.0, 1.0, hb2.x < coverB * 1.15), res);
  }
  if (built <= 0.0 && road <= 0.0) { return CityLook(ground, 0.0); }
  return CityLook(mix(col, CITY_ASPHALT, road * 0.85 * (1.0 - built)), max(built, road * 0.85));
}
