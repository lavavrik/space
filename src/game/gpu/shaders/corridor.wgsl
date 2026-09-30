// A station's approach corridor and its lights (render/shaders/corridor.frag.glsl, corridorLight.*.glsl).
//
// The corridor: a faint box of green light running out from the slot along the spin axis while you
// have a pad there (or another ship is in it); bright along its edges, pulses running in, fading
// with distance from the station. Display-referred and added; alpha multiplies the meter weight.
//
// The lights: one camera-facing quad per lamp, ~LAMP_M across but never under 3 px, pulses running
// toward the slot; all amber while another ship has the slot, running the way it's going.
// #include frame
// #include stationBody

@group(1) @binding(0) var<uniform> so: Obj;

@fragment
fn fs(in: BodyOut) -> @location(0) vec4f {
  let time = so.v[3].w;
  let len = so.v[5].x;
  let grow0 = so.v[5].y;
  let along = clamp((in.obj.z - 0.5) / len, 0.0, 1.0); // 0 at the slot, 1 at the far end
  let grow = 1.0 + along * (grow0 - 1.0);
  let q = abs(in.obj.xy) / (vec2f(0.2, 0.06) * grow);
  let edge = smoothstep(0.93, 1.0, min(q.x, q.y));
  let pulse = pow(fract(along * 12.0 + time * 0.6), 8.0);
  let a = (0.03 + 0.45 * edge + 0.3 * pulse) * (1.0 - along) * (1.0 - along * 0.6);
  return vec4f(vec3f(0.25, 1.0, 0.55) * a, 1.0 - clamp(a * 4.0, 0.0, 1.0));
}

const LAMP_M: f32 = 30.0;

struct LampOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) c: vec3f,
}

@vertex
fn vsLamp(@builtin(vertex_index) vi: u32, @location(0) position: vec3f, @location(1) along: f32, @location(2) side: f32) -> LampOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let c = corners[vi];
  let time = so.v[3].w;
  let busy = so.v[5].z;
  let dir = so.v[5].w;
  let wp = so.model * vec4f(position, 1.0);
  let dist = length(wp.xyz);
  let px = clamp(LAMP_M / dist * so.v[6].x, 3.0, 14.0);
  let run = pow(fract(along * 6.0 + dir * time * 0.7), 10.0);
  var col = select(vec3f(1.0, 0.25, 0.18), vec3f(0.25, 1.0, 0.45), side > 0.0);
  if (busy > 0.5) { col = vec3f(1.0, 0.62, 0.12); }
  var o: LampOut;
  var clip = frame.viewProj * wp;
  clip = vec4f(clip.xy + c * px / frame.viewport * clip.w, clip.z, clip.w);
  o.pos = clip;
  o.uv = c;
  o.c = col * (0.55 + 1.6 * run) * (1.0 - 0.35 * along);
  return o;
}

@fragment
fn fsLamp(in: LampOut) -> @location(0) vec4f {
  let r = length(in.uv);
  let a = exp(-r * r * 3.0) * (1.0 - smoothstep(0.8, 1.0, r));
  var c = in.c * a;
  c += vec3f(max(0.0, max(c.r, max(c.g, c.b)) - 0.8) * 0.6);
  return vec4f(c, 0.0);
}
