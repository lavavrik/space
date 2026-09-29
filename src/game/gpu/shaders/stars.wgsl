// Every other system in sight as a star (render/shaders/skyPoint.*.glsl): a soft round spot of its
// colour × intensity, whose overflow bleeds into white at the core, so bright stars get a white centre
// in a halo of their own colour. WebGPU has no sized points, so each is a camera-facing quad of
// `size` CSS px, placed at infinity along its direction (w = 0: it lands on the far plane).
//
// #include frame

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec3f,
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) dir: vec3f, @location(1) color: vec3f, @location(2) size: f32) -> Out {
  // two triangles: corners (−1,−1) (1,−1) (−1,1) (−1,1) (1,−1) (1,1)
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  var clip = frame.viewProj * vec4f(dir, 0.0);
  var o: Out;
  if (clip.w <= 0.0) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0); // behind the camera: off screen
    return o;
  }
  let px = size * frame.pr * 0.5; // half-size in render px
  clip = vec4f(clip.xy + c * px * 2.0 / frame.viewport * clip.w, clip.z, clip.w);
  o.pos = clip;
  o.uv = c;
  o.color = color;
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let r = length(in.uv);
  let a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.85, 1.0, r));
  var c = in.color * a;
  let m = max(c.r, max(c.g, c.b));
  c += vec3f(max(0.0, m - 0.75) * 0.8);
  return vec4f(c * frame.starExp, 0.0);
}
