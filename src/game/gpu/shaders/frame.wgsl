// Per-frame uniforms, bind group 0 for every pass (gpu/GpuRenderer.ts writes them).
struct Frame {
  // camera-relative view-projection (the camera at the origin), reversed-Z with an infinite far plane
  viewProj: mat4x4f,
  // the camera's orientation (camera → world): turns a view direction into a world direction
  camRot: mat4x4f,
  viewport: vec2f,  // render target size (px)
  proj: vec2f,      // the projection's x and y scale (P[0][0], P[1][1])
  pr: f32,          // pixel ratio (render px per CSS px)
  time: f32,        // sim time (s)
  exposure: f32,    // physical light × exposure = display value (render/exposure.ts)
  skyExp: f32,      // the Milky Way's share of it
  starExp: f32,     // the stars'
  // lights in scene units (render/exposure.ts): the headlights, floodlights, the headlights inside
  // (÷ interior light), interior light, windows, the sky's level
  headK: f32,
  floodK: f32,
  headKi: f32,
  headDir: vec4f,   // the ship's nose (world axes); w: headlights on (0 or 1)
  intK: f32,
  winK: f32,
  skyK: f32,
  _pad0: f32,
  landDir: vec4f,   // the landing lights' axis (world axes); w: on (0 or 1)
}

// The ship's headlights, as a physical lamp (render/shaders/headlight.glsl): a cone along the nose
// (the camera at the origin of camera-relative positions) with inverse-square falloff; `K` turns
// candela into brightness at the current exposure.
fn headlight(N: vec3f, wp: vec3f, albedo: vec3f, K: f32) -> vec3f {
  let d = max(length(wp), 5.0);
  let toSurf = wp / d;
  let cone = smoothstep(0.91, 0.96, dot(toSurf, frame.headDir.xyz)); // ~16–24° half-angle, soft edge
  let ndl = max(dot(N, -toSurf), 0.0);
  return albedo * vec3f(1.0, 0.96, 0.88) * cone * ndl * frame.headDir.w * K / (d * d);
}
// The landing lights (sim/landingLights.ts): a wide cone (~40–60° half-angle) down under the hull,
// a third as bright as the headlights and spread from a few metres off the ship (the lamps sit
// apart under the hull; as one point they blew the ground under a landed ship out to white)
const LAND_REL: f32 = 0.35;
fn landingLight(N: vec3f, wp: vec3f, albedo: vec3f) -> vec3f {
  let d = max(length(wp), 3.0);
  let toSurf = wp / d;
  let cone = smoothstep(0.5, 0.75, dot(toSurf, frame.landDir.xyz));
  let ndl = max(dot(N, -toSurf), 0.0);
  return albedo * vec3f(1.0, 0.97, 0.92) * cone * ndl * frame.landDir.w * frame.headK * LAND_REL / (d * d + 900.0);
}

// all the ship's lamps on a surface: the headlights and the landing lights
fn shipLights(N: vec3f, wp: vec3f, albedo: vec3f) -> vec3f {
  return headlight(N, wp, albedo, frame.headK) + landingLight(N, wp, albedo);
}

// how much of the ship's lamps' light reaches a point in the air (its cones, 1/d²; for scattering
// in fog and cloud, vclouds.wgsl)
fn shipLightAt(wp: vec3f) -> f32 {
  let d = max(length(wp), 3.0);
  let toP = wp / d;
  let head = smoothstep(0.91, 0.96, dot(toP, frame.headDir.xyz)) * frame.headDir.w;
  let land = smoothstep(0.5, 0.75, dot(toP, frame.landDir.xyz)) * frame.landDir.w;
  return head * frame.headK / (d * d) + land * frame.headK * LAND_REL / (d * d + 900.0);
}

@group(0) @binding(0) var<uniform> frame: Frame;

// one triangle covering the viewport (vertex_index 0, 1, 2)
fn fullscreen(i: u32) -> vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// the world direction through a pixel (framebuffer coordinates)
fn viewDir(px: vec2f) -> vec3f {
  let ndc = vec2f(px.x / frame.viewport.x * 2.0 - 1.0, 1.0 - px.y / frame.viewport.y * 2.0);
  let v = vec3f(ndc.x / frame.proj.x, ndc.y / frame.proj.y, -1.0);
  return normalize((frame.camRot * vec4f(v, 0.0)).xyz);
}

// The shadow map (gpu/shadowmap.ts; docs/shadows.md): three cascades round the camera, rendered
// from the star, which rocks, ships and stations cast into and they and the ground near you read.
struct ShadowMap {
  vp: array<mat4x4f, 6>, // camera-relative position → the cascade's clip space (depth: 0 at the sun's end); 3–5: a pair's second sun's (docs/binaries.md)
  radius: vec4f,         // each cascade's half-width (m); w: 1 while it's on
  texel: vec4f,          // each cascade's texel (m); w: the map's size (px)
  bias: vec4f,           // each cascade's depth bias (depth units)
  two: vec4f,            // x: 1 while the second sun's cascades are on
}
@group(0) @binding(1) var shadowTex: texture_depth_2d_array;
@group(0) @binding(2) var shadowSamp: sampler_comparison;
@group(0) @binding(3) var<uniform> shadowU: ShadowMap;
// the shadow passes' own: the cascade being drawn (only their vertex stages read it)
struct Caster {
  vp: mat4x4f,
}
@group(0) @binding(4) var<uniform> caster: Caster;

// how lit a camera-relative point with normal n is by the star past what's near (1 lit, 0 shadowed)
fn shadowAt(wp: vec3f, n: vec3f) -> f32 { return shadowOf(wp, n, 0); }
// …by a pair's second sun (its own cascades; lit if they're off)
fn shadowAt2(wp: vec3f, n: vec3f) -> f32 {
  if (shadowU.two.x < 0.5) { return 1.0; }
  return shadowOf(wp, n, 3);
}

// `k`: the first cascade's layer (0, or 3 for the second sun)
fn shadowOf(wp: vec3f, n: vec3f, k: i32) -> f32 {
  if (shadowU.radius.w < 0.5) { return 1.0; }
  let dist = length(wp);
  var c = 0;
  if (dist > shadowU.radius.x * 0.9) { c = 1; }
  if (dist > shadowU.radius.y * 0.9) { c = 2; }
  if (dist > shadowU.radius.z * 0.95) { return 1.0; }
  let tx = shadowU.texel[c];
  let q = shadowU.vp[k + c] * vec4f(wp + n * tx * 1.5, 1.0); // (pushed off the surface a little: no acne)
  let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 || q.z >= 1.0) { return 1.0; }
  // 3 × 3 percentage-closer filtering: soft edges a couple of texels wide
  let st = 1.0 / shadowU.texel.w;
  var s = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      s += textureSampleCompareLevel(shadowTex, shadowSamp, uv + vec2f(f32(x), f32(y)) * st, k + c, q.z - shadowU.bias[c]);
    }
  }
  // fading out toward the last cascade's edge
  return mix(s / 9.0, 1.0, smoothstep(0.75, 0.95, dist / shadowU.radius.z));
}

// The same at a point in the air (no surface to push off, one tap: the volumetric clouds, where the
// march's jitter and the temporal blend soften it)
fn shadowAtPoint(wp: vec3f) -> f32 {
  if (shadowU.radius.w < 0.5) { return 1.0; }
  let dist = length(wp);
  var c = 0;
  if (dist > shadowU.radius.x * 0.9) { c = 1; }
  if (dist > shadowU.radius.y * 0.9) { c = 2; }
  if (dist > shadowU.radius.z * 0.95) { return 1.0; }
  let q = shadowU.vp[c] * vec4f(wp, 1.0);
  let uv = vec2f(q.x * 0.5 + 0.5, 0.5 - q.y * 0.5);
  if (uv.x <= 0.0 || uv.y <= 0.0 || uv.x >= 1.0 || uv.y >= 1.0 || q.z >= 1.0) { return 1.0; }
  let s = textureSampleCompareLevel(shadowTex, shadowSamp, uv, c, q.z - shadowU.bias[c] * 4.0);
  return mix(s, 1.0, smoothstep(0.75, 0.95, dist / shadowU.radius.z));
}
