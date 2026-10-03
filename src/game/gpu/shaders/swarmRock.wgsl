// A trojan swarm's rocks (gpu/swarm.ts, sim/swarm.ts): the CPU lists the rocks near the camera and
// this draws each as the unit icosphere's directions pushed out by three octaves of value noise at a
// per-rock offset (the same shape the mining laser's ray reads: sim/swarm.ts swarmShapeR), squashed
// by the rock's own scales and turned by its quaternion, flat-shaded (the facets read as rock). Dry,
// dark rock lit like regolith (Lommel–Seeliger mixed with Lambert); metal-rich cores are paler and
// glint. Only the star lights it: a swarm is far from anything else.
// #include frame

struct Swarm {
  sun: vec4f, // direction to the star (world axes); w: unused
  col: vec4f, // the star's colour
}
@group(1) @binding(0) var<uniform> sw: Swarm;

struct VIn {
  @location(0) d: vec3f,  // the base sphere's direction
  @location(1) p: vec4f,  // the rock's centre (camera-relative); w: tint
  @location(2) q: vec4f,  // its orientation
  @location(3) sc: vec4f, // its axes' lengths (m); w: 1 if metal-rich
  @location(4) o: vec4f,  // its shape's offset; w: its seed
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) k: vec4f, // tint, metal, seed, size
}

// value noise on a hashed integer lattice (sim/swarm.ts vnoise: the same)
fn lattice(i: vec3i) -> f32 {
  var h = bitcast<u32>(i.x) * 374761393u + bitcast<u32>(i.y) * 668265263u + bitcast<u32>(i.z) * 1274126177u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h) / 4294967296.0 * 2.0 - 1.0;
}
fn smooth3(t: vec3f) -> vec3f { return t * t * (3.0 - 2.0 * t); }
fn vnoise(p: vec3f) -> f32 {
  let fl = floor(p);
  let i = vec3i(fl);
  let f = smooth3(p - fl);
  let x00 = mix(lattice(i), lattice(i + vec3i(1, 0, 0)), f.x);
  let x10 = mix(lattice(i + vec3i(0, 1, 0)), lattice(i + vec3i(1, 1, 0)), f.x);
  let x01 = mix(lattice(i + vec3i(0, 0, 1)), lattice(i + vec3i(1, 0, 1)), f.x);
  let x11 = mix(lattice(i + vec3i(0, 1, 1)), lattice(i + vec3i(1, 1, 1)), f.x);
  return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}
fn shapeR(d: vec3f, o: vec3f) -> f32 {
  return 1.0 + 0.30 * vnoise(d * 0.9 + o) + 0.14 * vnoise(d * 2.1 + o.yzx) + 0.06 * vnoise(d * 4.7 + o.zxy);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

@vertex
fn vs(in: VIn) -> VOut {
  var o: VOut;
  let local = in.d * shapeR(in.d, in.o.xyz) * in.sc.xyz;
  let wp = in.p.xyz + qrot(in.q, local);
  o.wp = wp;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  o.k = vec4f(in.p.w, in.sc.w, in.o.w, length(in.sc.xyz));
  return o;
}

// into the shadow map (gpu/shadowmap.ts): the same shape, its position only
@vertex
fn vsShadow(in: VIn) -> @builtin(position) vec4f {
  let local = in.d * shapeR(in.d, in.o.xyz) * in.sc.xyz;
  return caster.vp * vec4f(in.p.xyz + qrot(in.q, local), 1.0);
}

fn hash1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  var N = normalize(cross(dpdx(in.wp), dpdy(in.wp)));
  let V = normalize(-in.wp);
  if (dot(N, V) < 0.0) { N = -N; }
  let L = normalize(sw.sun.xyz);
  let metal = in.k.y > 0.5;
  // dark carbonaceous to a duller brown by its tint; metal cores paler and bluer
  var base = mix(vec3f(0.045, 0.043, 0.040), vec3f(0.16, 0.135, 0.105), in.k.x * in.k.x);
  base *= 0.8 + 0.4 * hash1(in.k.z + floor(in.wp.x * 0.37) * 3.1 + floor(in.wp.y * 0.41) * 1.7);
  if (metal) { base = mix(vec3f(0.30, 0.31, 0.33), vec3f(0.42, 0.40, 0.36), in.k.x * 12.0); }
  let ndl = max(dot(N, L), 0.0);
  let ndv = max(dot(N, V), 1e-3);
  // Lommel–Seeliger (bright at the limb, flat in the middle) mixed with Lambert
  let ls = ndl / (ndl + ndv);
  let lit = mix(ndl, ls * 2.0, 0.5);
  var col = base * sw.col.rgb * lit * shadowAt(in.wp, N); // other rocks' shadows
  if (metal) {
    let H = normalize(L + V);
    col += sw.col.rgb * pow(max(dot(N, H), 0.0), 40.0) * 0.5 * ndl * shadowAt(in.wp, N);
  }
  col += headlight(N, in.wp, base, frame.headK);
  col *= frame.exposure;
  return vec4f(col, 1.0);
}
