// Distant bodies as dots of reflected starlight (render/shaders/point.*.glsl): camera-facing quads of
// `size` render px at camera-relative positions (WebGPU has no sized points), a soft round spot, added.
// #include frame

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) at: vec3f, @location(1) color: vec3f, @location(2) size: f32) -> Out {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var clip = frame.viewProj * vec4f(at, 1.0);
  var o: Out;
  if (clip.w <= 0.0) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  clip = vec4f(clip.xy + c * size * 0.5 * 2.0 / frame.viewport * clip.w, clip.z, clip.w);
  o.pos = clip;
  o.uv = c;
  o.color = color;
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let r = length(in.uv);
  let a = exp(-r * r * 3.5) * (1.0 - smoothstep(0.8, 1.0, r));
  return vec4f(in.color * a, 0.0);
}
