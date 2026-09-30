// A station's uniforms (gpu/stations.ts writes them) and the vertex stage its meshes share
// (render/shaders/body.vert.glsl). Every station material reads the same block; each uses its slots:
//   v[0]  direction to the star; w: lit (0 in the parent's shadow)
//   v[1]  the star's colour (for the hull); w: seed
//   v[2]  direction to the parent world; w: cosine of its angular radius
//   v[3]  the parent world's colour; w: time (s, wall clock)
//   v[4]  the granted pad's centre (unit coordinates); w: 1 if a pad is granted here
//   v[5]  corridor: length (unit coordinates), how much wider its far end is; approach lights: busy, direction
//   v[6]  approach lights: render px per radian; sky station: pad radius, the granted pad (−1: none)
//   v[7]  sky station: its up (world axes)
//   v[8…13] sky station: the pads' centres (12 × vec2)
// Each shader declares `so` at its own group (the sky station has its world's air at group 1).

struct Obj {
  model: mat4x4f, // unit coordinates → camera-relative (position, turn, the station's size)
  v: array<vec4f, 16>, // (14: a pair's second sun's direction, w 1 if there is one; 15: its light relative to the first's, docs/binaries.md)
}

struct BodyOut {
  @builtin(position) pos: vec4f,
  @location(0) obj: vec3f,
  @location(1) wn: vec3f,
  @location(2) wp: vec3f,
}

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> BodyOut {
  var o: BodyOut;
  let wp = so.model * vec4f(position, 1.0);
  o.obj = position;
  o.wp = wp.xyz;
  o.wn = normalize((so.model * vec4f(normal, 0.0)).xyz);
  o.pos = frame.viewProj * wp;
  return o;
}

// into the shadow map (gpu/shadowmap.ts)
@vertex
fn vsShadow(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return caster.vp * (so.model * vec4f(position, 1.0));
}

fn shash(p: vec2f, seed: f32) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7)) + seed) * 43758.5453); }

// alpha: the physical share of the pixel, so the exposure meter ignores signal lights (render/hdr.ts)
fn physShare(col: vec3f, sig: vec3f) -> vec4f {
  let W = vec3f(0.2126, 0.7152, 0.0722);
  return vec4f(col + sig, dot(col, W) / (dot(col + sig, W) + 1e-9));
}
