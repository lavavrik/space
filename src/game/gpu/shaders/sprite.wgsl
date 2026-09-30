// A camera-facing sprite for particles and grains (particles.wgsl, fields.wgsl): a soft dot at a
// camera-relative point, `size` metres across but never under MIN_PX pixels (smaller ones keep their
// light, dimmed by their share of a pixel), stretched along `streak` (camera-relative metres: where
// it was a moment ago) into a streak whose light is spread along it. Needs frame.

const MIN_PX: f32 = 1.5;

struct SpriteOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,   // −1…1 across, −1…1 along (streaks)
  @location(1) col: vec3f,
  @location(2) w: f32,      // its width on screen (px)
}

fn sprite(vi: u32, c: vec3f, streak: vec3f, size: f32, col: vec3f) -> SpriteOut {
  var o: SpriteOut;
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let k = corners[vi];
  let a = frame.viewProj * vec4f(c, 1.0);
  let b = frame.viewProj * vec4f(c - streak, 1.0);
  if (a.w <= 0.1 || b.w <= 0.1) {
    o.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    return o;
  }
  let half = frame.viewport * 0.5;
  let pa = a.xy / a.w * half;
  let pb = b.xy / b.w * half;
  // its size on screen (px), and the light kept when it's under MIN_PX
  let px = size * frame.proj.y * half.y / a.w;
  let w = max(px, MIN_PX);
  var bright = min(1.0, (px * px) / (MIN_PX * MIN_PX));
  var axis = pb - pa;
  let len = length(axis);
  if (len > 0.5) { axis /= len; } else { axis = vec2f(1.0, 0.0); }
  let perp = vec2f(-axis.y, axis.x);
  // along: from a (k.y = −1) to b (k.y = 1), plus half a width of cap at each end
  let t = k.y * 0.5 + 0.5;
  let along = mix(pa, pb, t) + axis * k.y * w * 0.5;
  let p = along + perp * k.x * w * 0.5;
  bright /= 1.0 + len / w; // a streak spreads its light along it
  o.pos = vec4f(p / half * a.w, a.z, a.w);
  o.uv = vec2f(k.x, k.y);
  o.col = col * bright;
  o.w = w;
  return o;
}

fn spriteLight(in: SpriteOut) -> vec4f {
  let r = abs(in.uv.x);
  var a = exp(-r * r * 3.5) * (1.0 - smoothstep(0.8, 1.0, r)) * (1.0 - smoothstep(0.7, 1.0, abs(in.uv.y)) * 0.6);
  if (in.w < 3.0) { a = 0.6; } // (a couple of pixels: a soft profile would only show its dim edge)
  return vec4f(in.col * a, 0.0); // (alpha 0: out of the exposure meter)
}
