// A ring's rocks (render/RingField.ts ROCK_GLSL; sim/rings.ts, docs/rings.md): a rock from its
// candidate index, the same every visit. Each layer is a grid of cells centred on the camera in the
// ring's co-orbiting frame, a few candidates per cell; a hash of the cell's global indices gives a
// rock's place, size, tint, orientation and whether it's there at all (the ring's density).
//
// Bin table (`bins`, 3 rows of `grid`): row 0 = (the bin's radius less the camera's (m), the camera's
// fractional cell in the bin's co-orbiting frame, density 0…1, the bin's cell angle (rad)); row 1 =
// (the bin's global radial index, the camera's angular cell round the bin ÷ 4096 and mod 4096);
// row 2 = (cells round the bin ÷ 4096 and mod 4096).

struct Layer {
  e1: vec4f,       // in-plane axis toward the camera; w: candidates per cell
  e2: vec4f,       // in-plane axis along the orbit; w: cell size (m)
  n: vec4f,        // the ring's normal; w: half thickness (m)
  color: vec4f,    // the ring's colour; w: seed
  light: vec4f,    // direction to the star; w: the planet's radius (m)
  pc: vec4f,       // the planet's centre, camera-relative; w: its albedo (planetshine)
  inner: f32,      // nearer than this, none (m)
  fadeTo: f32,     // fading in up to here (m), 0: no fade-in
  range: f32,      // out to here (m)
  outK: f32,       // shrinking away from range × outK
  rc: f32,         // the camera's distance from the axis (m)
  hc: f32,         // and height above the plane (m)
  minR: f32,
  maxR: f32,
  cutMin: f32,     // this copy's band of distance (which mesh detail draws a rock)
  cutMax: f32,
  px: f32,         // render pixels per radian (specks' sizes)
  minedN: f32,
  grid: f32,
  window: f32,     // a nearer copy uses only the central window × window cells
  count: f32,      // candidates (window² × per cell)
  fine: f32,       // 1: normals from the shape itself
  cap: f32,        // the output list's capacity
  metalRich: f32,  // sim/ringRocks.ts METAL_RICH
  _p0: f32,
  _p1: f32,
  // rocks mined down (sim/laser.ts): (radial bin, cell ÷ 4096, cell mod 4096, candidate) → share left
  mined: array<vec4f, 24>,
  minedS: array<vec4f, 6>,
}

fn pcg3(v0: vec3u) -> vec3u {
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

var<private> rkS: u32; // the rock's random stream
fn rnd() -> f32 {
  rkS = rkS * 747796405u + 2891336453u;
  let s = rkS;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
}

// smoothstep for either order of edges
fn smr(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// a rock's colour from its tint draw: the ring's colour, lighter or darker; metal-rich rocks (under
// metalRich) a darker warm grey whatever the ring's colour
fn rockMetal(t: f32) -> bool { return t < layer.metalRich; }
fn rockCol(t: f32) -> vec3f {
  if (rockMetal(t)) { return dot(layer.color.rgb, vec3f(0.3, 0.59, 0.11)) * vec3f(0.66, 0.58, 0.48); }
  return layer.color.rgb * (0.5 + 0.6 * t);
}

// the planet's shadow: behind it, within its radius of the line to the star
fn ringShadow(p: vec3f) -> f32 {
  let L = normalize(layer.light.xyz);
  let toP = p - layer.pc.xyz;
  let along = dot(toP, L);
  if (along < 0.0 && length(toP - along * L) < layer.light.w) { return 0.0; }
  return 1.0;
}

// sin and cos of a tiny angle (a rock's angle round the ring from the camera: its distance ÷ the
// ring's radius, ~10⁻⁶ rad at 10⁸ m) by their series, exact there. The built-in sin is accurate only
// to ~10⁻⁶ absolute on NVIDIA (D3D's fast sine): mostly noise at these angles, so there the rocks
// jumped between quantised places as you moved, like a slideshow (Apple's is fine small).
fn sinT(x: f32) -> f32 { let x2 = x * x; return x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0)); }
fn cosT(x: f32) -> f32 { let x2 = x * x; return 1.0 - x2 / 2.0 * (1.0 - x2 / 12.0); }

var<private> rkP: vec3f;     // camera-relative place
var<private> rkSize: f32;    // radius (m)
var<private> rkTint: f32;    // tint draw (rockCol)
var<private> rkFade: f32;    // 0…1

// the rock with this candidate index: false if there's none
fn ringRock(id: i32) -> bool {
  let K = i32(layer.e1.w + 0.5);
  let G = i32(layer.grid + 0.5);
  let W = i32(layer.window + 0.5);
  let cid = id / K;
  let q = id - cid * K;
  let li = cid / W;
  let lj = cid - li * W;
  let bi = (G - W) / 2 + li;
  let bj = (G - W) / 2 + lj;
  let A = bins[bi];
  let B = bins[G + bi];
  let C = bins[2 * G + bi];
  if (A.z <= 0.0) { return false; }
  let jrel = bj - G / 2;
  let nth = i32(C.x) * 4096 + i32(C.y);
  let jc = i32(B.y) * 4096 + i32(B.z);
  var jj = (jc + jrel) % nth;
  if (jj < 0) { jj += nth; }
  let hv = pcg3(vec3u(u32(i32(B.x) + 1073741824), u32(jj), u32(q) + u32(layer.color.w) * 977u));
  rkS = hv.x ^ hv.y ^ hv.z;
  if (rnd() > A.z) { return false; } // the ring's density
  let du = (rnd() - 0.5) * layer.e2.w;
  let u = rnd();
  let zz = (rnd() * 2.0 - 1.0) * layer.n.w;
  // in the ring's axes turned to the camera (it's at radius rc, height hc, angle 0)
  let dphi = (f32(jrel) + u - A.y) * A.w;
  let rr = A.x + du;
  let sh2 = sinT(0.5 * dphi);
  let p = layer.e1.xyz * (rr * cosT(dphi) - 2.0 * layer.rc * sh2 * sh2) + layer.e2.xyz * ((layer.rc + rr) * sinT(dphi)) + layer.n.xyz * (zz - layer.hc);
  let d = length(p);
  if (d > layer.range || d < layer.inner || d < layer.cutMin || d > layer.cutMax) { return false; }
  var size = layer.minR * pow(layer.maxR / layer.minR, pow(rnd(), 2.2));
  // mined down: smaller, or gone
  let jh = f32(jj / 4096);
  let jl = f32(jj - (jj / 4096) * 4096);
  for (var m = 0; m < 24; m++) {
    if (f32(m) >= layer.minedN) { break; }
    let e = layer.mined[m];
    if (e.x == B.x && e.y == jh && e.z == jl && e.w == f32(q)) {
      let left = layer.minedS[m / 4][m % 4];
      if (left <= 0.0) { return false; }
      size *= left;
      break;
    }
  }
  rkTint = rnd();
  var fade = smr(layer.range, layer.range * layer.outK, d);
  if (layer.fadeTo > 0.0) { fade *= smoothstep(layer.inner, layer.fadeTo, d); }
  rkP = p;
  rkSize = size;
  rkFade = fade;
  return true;
}
