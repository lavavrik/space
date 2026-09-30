// Ships and effects (render/Traffic.ts, Laser.ts, Hyperspace.ts, SceneRenderer.ts's orbit preview).
// Everything here except the hulls is display-referred light with alpha 0 (out of the exposure meter).
// #include frame

struct Fx {
  light: vec4f, // direction to the star (the hulls' light); w: the beam's intensity
  time: f32,    // wall clock (s): the beam's shimmer
  _p0: f32,
  _p1: f32,
  _p2: f32,
}
@group(1) @binding(0) var<uniform> fx: Fx;

// Other ships' hulls: a small procedural model per ship, lit by the star (Traffic.ts HULL_*).
struct HullOut {
  @builtin(position) pos: vec4f,
  @location(0) n: vec3f,
  @location(1) lit: f32, // the share of the star it sees (sim/eclipse.ts)
  @location(2) wp: vec3f,
}

@vertex
fn vsHull(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f, @location(6) lit: f32) -> HullOut {
  let model = mat4x4f(m0, m1, m2, m3);
  var o: HullOut;
  o.lit = lit;
  o.n = normalize((model * vec4f(normal, 0.0)).xyz);
  let wp = model * vec4f(position, 1.0);
  o.wp = wp.xyz;
  o.pos = frame.viewProj * wp;
  return o;
}

@vertex
fn vsHullShadow(@location(0) position: vec3f, @location(2) m0: vec4f, @location(3) m1: vec4f, @location(4) m2: vec4f, @location(5) m3: vec4f) -> @builtin(position) vec4f {
  return caster.vp * (mat4x4f(m0, m1, m2, m3) * vec4f(position, 1.0));
}

@fragment
fn fsHull(in: HullOut) -> @location(0) vec4f {
  let d = max(dot(normalize(in.n), fx.light.xyz), 0.0) * in.lit * shadowAt(in.wp, normalize(in.n));
  return vec4f(vec3f(0.62, 0.64, 0.68) * (0.04 + 0.6 * d), 1.0);
}

// Lines: FTL trails and hyperspace streaks (added), the orbit preview (blended). Colours come per
// vertex, already faded.
struct LineOut {
  @builtin(position) pos: vec4f,
  @location(0) c: vec4f,
}

@vertex
fn vsLine(@location(0) position: vec3f, @location(1) color: vec4f) -> LineOut {
  var o: LineOut;
  o.pos = frame.viewProj * vec4f(position, 1.0);
  o.c = color;
  return o;
}

@fragment
fn fsLineAdd(in: LineOut) -> @location(0) vec4f { return vec4f(in.c.rgb, 0.0); }

@fragment
fn fsLineBlend(in: LineOut) -> @location(0) vec4f { return in.c; }

// hyperspace streaks: vertex colours at sky level, sRGB-encoded as the stock line material wrote them
@fragment
fn fsStreak(in: LineOut) -> @location(0) vec4f { return vec4f(pow(max(in.c.rgb, vec3f(0.0)), vec3f(1.0 / 2.2)) * frame.starExp, 0.0); }

// The mining laser's beam (Laser.ts BEAM_*): a camera-facing ribbon, bright at its core, shimmering.
struct BeamOut {
  @builtin(position) pos: vec4f,
  @location(0) sa: vec2f, // across (−1…1), along (m)
}

@vertex
fn vsBeam(@location(0) position: vec3f, @location(1) sa: vec2f) -> BeamOut {
  var o: BeamOut;
  o.pos = frame.viewProj * vec4f(position, 1.0);
  o.sa = sa;
  return o;
}

@fragment
fn fsBeam(in: BeamOut) -> @location(0) vec4f {
  let s = in.sa.x;
  let core = exp(-s * s * 18.0);
  let glow = exp(-s * s * 3.0) * 0.35;
  let shimmer = 0.85 + 0.15 * sin(in.sa.y * 0.08 - fx.time * 40.0);
  let c = vec3f(1.0, 0.95, 0.9) * core + vec3f(1.0, 0.35, 0.15) * glow;
  return vec4f(c * fx.light.w * shimmer, 0.0);
}
