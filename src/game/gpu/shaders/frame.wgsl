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
