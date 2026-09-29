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
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
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
