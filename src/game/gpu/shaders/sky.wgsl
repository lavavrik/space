// The Milky Way behind everything: the baked cube map (skyBake.wgsl) looked up along each pixel's
// direction, squared back from the sqrt it was stored as (render/shaders/skyCube.frag.glsl). Through
// the periscope a sharper patch baked for the view replaces the cube inside its frame, fading into it
// at the edges; a new patch crossfades from the previous one (mixK) so re-bakes never pop.
//
// #include frame

@group(1) @binding(0) var skyTex: texture_cube<f32>;
@group(1) @binding(1) var skySamp: sampler;
@group(1) @binding(2) var patchTex: texture_2d<f32>;
@group(1) @binding(3) var patchPrevTex: texture_2d<f32>;
struct Patch {
  vp: mat4x4f,     // the patch's view-projection (direction → its clip space)
  prevVP: mat4x4f,
  on: f32,         // weight (0…1): it blends in as the zoom grows
  mixK: f32,       // the new patch's share against the previous one
  _p0: f32,
  _p1: f32,
}
@group(1) @binding(4) var<uniform> pv: Patch;

fn patchOr(t: texture_2d<f32>, vp: mat4x4f, d: vec3f, base: vec3f) -> vec3f {
  let q = vp * vec4f(d, 1.0);
  if (q.w <= 0.0) { return base; }
  let n = q.xy / q.w;
  let e = max(abs(n.x), abs(n.y));
  if (e >= 1.0) { return base; }
  // (row 0 at the top)
  let c = textureSampleLevel(t, skySamp, vec2f(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5), 0.0).rgb;
  return mix(base, c, 1.0 - smoothstep(0.85, 1.0, e));
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return fullscreen(i);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = viewDir(pos.xy);
  var c = textureSample(skyTex, skySamp, d).rgb;
  if (pv.on > 0.0) {
    c = mix(c, mix(patchOr(patchPrevTex, pv.prevVP, d, c), patchOr(patchTex, pv.vp, d, c), pv.mixK), pv.on);
  }
  return vec4f(c * c * frame.skyExp, 1.0);
}
