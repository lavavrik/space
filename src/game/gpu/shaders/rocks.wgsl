// A ring layer's culled rocks drawn (render/RingField.ts MESH_* and DOT_*; the list from rocksCull.wgsl).
//
// Meshes: every rock has its own shape, the base icosphere's directions pushed out by three octaves
// of 3D noise at a per-rock offset, then squashed and turned, with normals from the shape itself
// (up close). The fragment shader adds fine relief (bump-mapped noise) and mottling, and lights it
// like regolith: Lommel–Seeliger mixed with Lambert, plus planetshine and the headlights; metal-rich
// rocks glint. Specks: camera-facing quads of 1–2 render px.
diagnostic(off, derivative_uniformity);
// #include frame
// #include rock

@group(1) @binding(0) var<uniform> layer: Layer;
@group(1) @binding(2) var noiseTex: texture_3d<f32>;
@group(1) @binding(3) var noiseSamp: sampler;
// (rock.wgsl's bin table isn't read when drawing, but its functions name it)
@group(1) @binding(4) var<storage, read> bins: array<vec4f>;

struct Rock {
  p: vec3f,
  size: f32,
  tint: f32,
  fade: f32,
  s: u32,
  _p: u32,
}
@group(1) @binding(1) var<storage, read> rocks: array<Rock>;
struct Speck {
  p: vec3f,
  px: f32,
  c: vec4f,
}
@group(1) @binding(1) var<storage, read> specks: array<Speck>;

fn tn(p: vec3f) -> f32 { return textureSampleLevel(noiseTex, noiseSamp, p * 0.125, 0.0).r * 2.0 - 1.0; }
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
fn shape(d: vec3f, o: vec3f) -> f32 { return 1.0 + 0.30 * tn(d * 0.9 + o) + 0.14 * tn(d * 2.1 + o.yzx) + 0.06 * tn(d * 4.7 + o.zxy); }

struct MeshOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) n: vec3f,
  @location(2) obj: vec3f,
  @location(3) col: vec3f,
  @location(4) k: vec4f, // size, shadow, metal (0 or 1)
}

// a rock's vertex: its place (camera-relative) and, with `normals`, its normal and the rest
fn rockVertex(position: vec3f, ii: u32, normals: bool) -> MeshOut {
  var o: MeshOut;
  let r = rocks[ii];
  rkS = r.s;
  // a random orientation (uniform quaternion), an elongation, and its own shape
  let u1 = rnd();
  let u2 = rnd() * 6.2831853;
  let u3 = rnd() * 6.2831853;
  let q = vec4f(sqrt(1.0 - u1) * sin(u2), sqrt(1.0 - u1) * cos(u2), sqrt(u1) * sin(u3), sqrt(u1) * cos(u3));
  let e1 = rnd();
  let e2 = rnd();
  let sc = vec3f(1.0, 0.55 + 0.4 * e1, 0.45 + 0.45 * e2) * r.size * r.fade; // shrinks away with the fade
  let o1 = rnd();
  let o2 = rnd();
  let o3 = rnd();
  let off = vec3f(o1, o2, o3) * 8.0;
  let d = normalize(position);
  let p0 = d * shape(d, off);
  var n = d; // far off (a few pixels): the sphere's normal will do
  if (normals && layer.fine > 0.5) {
    // up close: normals from the shape itself (finite differences on the sphere)
    var up = vec3f(1.0, 0.0, 0.0);
    if (abs(d.y) < 0.9) { up = vec3f(0.0, 1.0, 0.0); }
    let t1 = normalize(cross(d, up));
    let t2 = cross(d, t1);
    let d1 = normalize(d + 0.02 * t1);
    let d2 = normalize(d + 0.02 * t2);
    n = normalize(cross(d1 * shape(d1, off) - p0, d2 * shape(d2, off) - p0));
    if (dot(n, d) < 0.0) { n = -n; }
  }
  o.wp = r.p + qrot(q, p0 * sc);
  o.n = qrot(q, normalize(n / sc));
  o.obj = p0 + off;
  o.col = rockCol(r.tint);
  o.k = vec4f(r.size, ringShadow(r.p), select(0.0, 1.0, rockMetal(r.tint)), 0.0);
  return o;
}

@vertex
fn vsMesh(@location(0) position: vec3f, @builtin(instance_index) ii: u32) -> MeshOut {
  if (f32(ii) >= layer.cap) {
    var o: MeshOut;
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  var o = rockVertex(position, ii, true);
  o.pos = frame.viewProj * vec4f(o.wp, 1.0);
  return o;
}

// into the shadow map (gpu/shadowmap.ts): the shape only
@vertex
fn vsShadow(@location(0) position: vec3f, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  if (f32(ii) >= layer.cap) { return vec4f(2.0, 2.0, 2.0, 1.0); }
  return caster.vp * vec4f(rockVertex(position, ii, false).wp, 1.0);
}

// the noise filtered here at full precision (the GPU's own filter weights have only 8 bits, which
// magnified up close showed as square blocks)
fn tnq(p: vec3f) -> f32 {
  let x = p * 8.0 - 0.5;
  let i0 = floor(x);
  let f = x - i0;
  let a = vec3i(i0 - 64.0 * floor(i0 / 64.0));
  let b = vec3i((i0 + 1.0) - 64.0 * floor((i0 + 1.0) / 64.0));
  let c000 = textureLoad(noiseTex, vec3i(a.x, a.y, a.z), 0).r;
  let c100 = textureLoad(noiseTex, vec3i(b.x, a.y, a.z), 0).r;
  let c010 = textureLoad(noiseTex, vec3i(a.x, b.y, a.z), 0).r;
  let c110 = textureLoad(noiseTex, vec3i(b.x, b.y, a.z), 0).r;
  let c001 = textureLoad(noiseTex, vec3i(a.x, a.y, b.z), 0).r;
  let c101 = textureLoad(noiseTex, vec3i(b.x, a.y, b.z), 0).r;
  let c011 = textureLoad(noiseTex, vec3i(a.x, b.y, b.z), 0).r;
  let c111 = textureLoad(noiseTex, vec3i(b.x, b.y, b.z), 0).r;
  return mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y), mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z) * 2.0 - 1.0;
}
// an octave at frequency k: full precision only where it's magnified, the GPU's filtering elsewhere
var<private> fwObj: f32;
var<private> objP: vec3f;
fn tno(k: f32) -> f32 {
  let p = objP * k;
  if (fwObj * k * 8.0 < 0.3) { return tnq(p); }
  return tn(p);
}
fn bumpN(N: vec3f, H: f32, wp: vec3f) -> vec3f {
  let dpx = dpdx(wp);
  let dpy = dpdy(wp);
  let dhx = dpdx(H);
  let dhy = dpdy(H);
  let r1 = cross(dpy, N);
  let r2 = cross(N, dpx);
  let det = dot(dpx, r1);
  if (abs(det) < 1e-30) { return N; }
  return normalize(abs(det) * N - sign(det) * (dhx * r1 + dhy * r2));
}

@fragment
fn fsMesh(in: MeshOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var N = normalize(in.n);
  if (!front) { N = -N; }
  objP = in.obj;
  fwObj = length(fwidth(in.obj));
  let size = in.k.x;
  let sh = in.k.y;
  // fine relief: knobs and pits a few percent of the rock's size
  let H = (0.5 * tno(9.0) + 0.25 * tno(23.0) + 0.12 * tno(51.0)) * size * 0.05;
  N = bumpN(N, H, in.wp);
  let L = normalize(layer.light.xyz);
  let V = normalize(-in.wp);
  let mu0 = max(dot(N, L), 0.0);
  let mu = max(dot(N, V), 0.05);
  let sun = mix(mu0, 2.0 * mu0 / (mu0 + mu), 0.6) * sh * shadowAt(in.wp, N); // Lommel–Seeliger, a little Lambert; other rocks' shadows
  // planetshine: the giant's sunlit face, seen from here (rough), falling off with distance
  let toPl = layer.pc.xyz - in.wp;
  let dp = length(toPl);
  let Lp = toPl / dp;
  let pr = layer.light.w;
  let shine = layer.pc.w * (0.5 + 0.5 * dot(-Lp, L)) * (pr * pr) / (dp * dp) * max(dot(N, Lp), 0.0);
  let mottle = 0.8 + 0.2 * tno(3.1) + 0.1 * tno(13.0);
  var col = in.col * mottle * (sun + shine + 0.002);
  if (layer.light2.w > 0.5) {
    // a pair's second sun, in its colour, with its own shadows from other rocks
    let L2 = layer.light2.xyz;
    let m2 = max(dot(N, L2), 0.0);
    col += in.col * mottle * mix(m2, 2.0 * m2 / (m2 + mu), 0.6) * layer.lightC2.rgb * shadowAt2(in.wp, N);
  }
  // the headlights: rocks in the planet's shadow (or on their night side) light up in the cone
  col += headlight(N, in.wp, in.col * mottle, frame.headK);
  if (in.k.z > 0.5) {
    // metal-rich: bare metal in patches glints, in the sun and in the headlights' beam
    let bare = smoothstep(0.1, 0.4, tno(5.3));
    let Hv = normalize(L + V);
    let spec = pow(max(dot(N, Hv), 0.0), 60.0) * max(dot(N, L), 0.0) * sh;
    col += vec3f(1.0, 0.9, 0.75) * spec * (0.3 + 1.5 * bare) * length(in.col);
    let dh = max(length(in.wp), 5.0);
    let Lh = -in.wp / dh;
    let specH = pow(max(dot(N, Lh), 0.0), 60.0) * smoothstep(0.91, 0.96, dot(-Lh, frame.headDir.xyz)) * frame.headDir.w * frame.headK / (dh * dh);
    col += vec3f(1.0, 0.96, 0.88) * specH * (0.3 + 1.5 * bare) * length(in.col);
  }
  return vec4f(col * frame.exposure, 1.0);
}

struct SpeckOut {
  @builtin(position) pos: vec4f,
  @location(0) c: vec3f,
}

@vertex
fn vsSpeck(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpeckOut {
  var o: SpeckOut;
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  if (f32(ii) >= layer.cap) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let sp = specks[ii];
  var clip = frame.viewProj * vec4f(sp.p, 1.0);
  clip = vec4f(clip.xy + corners[vi] * sp.px / frame.viewport * clip.w, clip.z, clip.w);
  o.pos = clip;
  o.c = sp.c.rgb;
  return o;
}

@fragment
fn fsSpeck(in: SpeckOut) -> @location(0) vec4f {
  return vec4f(in.c * frame.exposure, 1.0);
}
