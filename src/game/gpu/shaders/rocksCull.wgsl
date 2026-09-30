// A ring layer's rocks, culled (docs/webgpu.md phase 4): one invocation per candidate works out its
// rock (rock.wgsl) and, if it's there and in view, appends it to the layer's list and counts it into
// the indirect draw's instance count. Only those are drawn (rocks.wgsl), where the WebGL renderer ran
// the whole vertex shader for every candidate to find most of them empty.
// #include frame
// #include rock

@group(1) @binding(0) var<uniform> layer: Layer;
@group(1) @binding(1) var<storage, read> bins: array<vec4f>;
@group(1) @binding(3) var<storage, read_write> args: array<atomic<u32>>; // the indirect draw's; [1] = instances

// a mesh rock: its place, size, tint, fade and random stream (for its shape)
struct Rock {
  p: vec3f,
  size: f32,
  tint: f32,
  fade: f32,
  s: u32,
  _p: u32,
}
@group(1) @binding(2) var<storage, read_write> rocks: array<Rock>;

// a speck: its place and size (render px), and its light
struct Speck {
  p: vec3f,
  px: f32,
  c: vec4f,
}
@group(1) @binding(2) var<storage, read_write> specks: array<Speck>;

// whether a sphere at camera-relative p of radius r can be on screen (the four side planes and behind)
fn inView(p: vec3f, r: f32) -> bool {
  let v = transpose(mat3x3f(frame.camRot[0].xyz, frame.camRot[1].xyz, frame.camRot[2].xyz)) * p;
  let z = -v.z;
  if (z < -r) { return false; }
  let ax = frame.proj.x;
  let ay = frame.proj.y;
  if ((abs(v.x) * ax - z) / sqrt(ax * ax + 1.0) > r) { return false; }
  if ((abs(v.y) * ay - z) / sqrt(ay * ay + 1.0) > r) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn cullMeshes(@builtin(global_invocation_id) gid: vec3u) {
  let id = i32(gid.x);
  if (f32(id) >= layer.count) { return; }
  if (!ringRock(id) || rkFade <= 0.0) { return; }
  let s = rkS;
  // in view, or (with shadows on) its shadow could be: where it falls along the sun's ray, a rock's
  // shadow reaching ~40 sizes (past that it's a penumbra too faint to matter), checked at its end and middle
  var seen = inView(rkP, rkSize * 1.6);
  if (!seen && shadowU.radius.w > 0.5) {
    let back = -normalize(layer.light.xyz) * min(rkSize * 40.0, shadowU.radius.z);
    seen = inView(rkP + back, rkSize * 1.6) || inView(rkP + back * 0.5, rkSize * 1.6);
  }
  if (!seen) { return; }
  let k = atomicAdd(&args[1], 1u);
  if (f32(k) >= layer.cap) { return; }
  rocks[k] = Rock(rkP, rkSize, rkTint, rkFade, s, 0u);
}

@compute @workgroup_size(64)
fn cullSpecks(@builtin(global_invocation_id) gid: vec3u) {
  let id = i32(gid.x);
  if (f32(id) >= layer.count) { return; }
  if (!ringRock(id)) { return; }
  let p = rkP;
  if (!inView(p, 0.0)) { return; }
  let px = 2.0 * rkSize * layer.px / length(p);
  let phase = 0.35 + 0.65 * max(dot(normalize(-p), normalize(layer.light.xyz)), 0.0); // brighter seen from the sun's side
  // a speck: never wider than 2 px (bigger dots read as flat discs), keeping the light of the rock
  // it stands for; below a pixel, dimmed by its share of one
  var light = min(max(px * px / 4.0, 1.0), 8.0);
  if (px < 1.0) { light = px * px; }
  let c = rockCol(rkTint) * ringShadow(p) * phase * rkFade * light * 0.5; // (a lit rock shows about half its disc)
  if (max(c.r, max(c.g, c.b)) <= 0.0) { return; }
  let k = atomicAdd(&args[1], 1u);
  if (f32(k) >= layer.cap) { return; }
  specks[k] = Speck(p, clamp(px, 1.0, 2.0), vec4f(c, 0.0));
}
