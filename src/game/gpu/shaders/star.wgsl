// The system's star (render/shaders/star.frag.glsl, glow.*.glsl): its disc, granulated and limb-darkened,
// and a glow billboard round it (core, halo, spikes) that keeps it a bright mark from anywhere.
// Display-referred, and alpha 0 keeps both out of the exposure meter.
// #include frame
// #include noise

struct Star {
  model: mat4x4f,   // unit sphere → camera-relative (its radius)
  color: vec4f,     // rgb; w: seed
  glowColor: vec4f, // rgb; w: intensity (uI)
  centre: vec4f,    // camera-relative; w: the glow's size (m)
  time: f32,
  _p0: f32,
  _p1: f32,
  _p2: f32,
}
@group(1) @binding(0) var<uniform> star: Star;

struct DiscOut {
  @builtin(position) pos: vec4f,
  @location(0) obj: vec3f,
  @location(1) wn: vec3f,
  @location(2) wp: vec3f,
}

@vertex
fn vsDisc(@location(0) position: vec3f, @location(1) normal: vec3f) -> DiscOut {
  var o: DiscOut;
  let wp = star.model * vec4f(position, 1.0);
  o.obj = position;
  o.wp = wp.xyz;
  o.wn = normal;
  o.pos = frame.viewProj * wp;
  return o;
}

@fragment
fn fsDisc(in: DiscOut) -> @location(0) vec4f {
  let p = normalize(in.obj);
  let N = normalize(in.wn);
  let V = normalize(-in.wp);
  let mu = clamp(dot(N, V), 0.0, 1.0);
  let t = star.time;
  let g = snoise(p * 45.0 + t * 0.04) * 0.5 + snoise(p * 120.0 - t * 0.07) * 0.3 + fbm(p * 5.0 + star.color.w, 4) * 0.5;
  let limb = 0.35 + 0.65 * pow(mu, 0.45);
  let c = mix(star.color.rgb, vec3f(1.0), 0.6 * mu) * limb * (1.0 + 0.13 * g);
  return vec4f(c * 1.2, 0.0);
}

struct GlowOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
}

@vertex
fn vsGlow(@builtin(vertex_index) vi: u32) -> GlowOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  // facing the camera: the camera's own right and up (camRot's columns)
  let right = frame.camRot[0].xyz;
  let up = frame.camRot[1].xyz;
  // (a 2 × 2 quad scaled by the size, as the WebGL renderer's plane: q runs −1…1)
  let wp = star.centre.xyz + (right * c.x + up * c.y) * star.centre.w;
  var o: GlowOut;
  o.q = c;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  return o;
}

@fragment
fn fsGlow(in: GlowOut) -> @location(0) vec4f {
  let r = length(in.q);
  let core = exp(-r * r * 22.0);
  let halo = pow(max(1.0 - r, 0.0), 4.0) * 0.5;
  let fall = pow(max(1.0 - r, 0.0), 2.0);
  let spikes = (exp(-abs(in.q.x) * 110.0) + exp(-abs(in.q.y) * 110.0)) * fall * 0.45;
  let col = star.glowColor.rgb;
  let c = (mix(col, vec3f(1.0), core) * (core + halo) + col * spikes) * star.glowColor.w;
  return vec4f(c, 0.0);
}
