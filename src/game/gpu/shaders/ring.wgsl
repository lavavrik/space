// A ring's disc (render/shaders/ring.frag.glsl): bands of noise across the radius, soft edges, a
// Cassini-like gap at 63 %, the planet's shadow; faded out close in where the rocks take over.
// #include frame
// #include noise
// #include ringband

struct Ring {
  model: mat4x4f,   // the disc (unit annulus in the xy plane, radii in planet radii) → camera-relative
  color: vec4f,     // rgb; w: seed
  light: vec4f,     // direction to the star; w: the planet's radius (m)
  pc: vec4f,        // the planet's centre, camera-relative; w: near fade (m), 0: none
  inner: f32,
  outer: f32,
  _p0: f32,
  _p1: f32,
  // a pair's second sun (docs/binaries.md): direction (w: 1 if there is one), light relative to the first's
  light2: vec4f,
  lightC2: vec4f,
}
@group(1) @binding(0) var<uniform> ring: Ring;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) obj: vec3f,
  @location(1) wp: vec3f,
  @location(2) wn: vec3f,
}

@vertex
fn vs(@location(0) position: vec3f) -> Out {
  var o: Out;
  let wp = ring.model * vec4f(position, 1.0);
  o.obj = position;
  o.wp = wp.xyz;
  o.wn = normalize((ring.model * vec4f(0.0, 0.0, 1.0, 0.0)).xyz);
  o.pos = frame.viewProj * wp;
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  var alpha = ringAlpha(length(in.obj.xy), ring.inner, ring.outer, ring.color.w);
  let fade = ring.pc.w;
  if (fade > 0.0) { alpha *= smoothstep(0.5 * fade, fade, length(in.wp)); }
  let L = normalize(ring.light.xyz);
  let toP = in.wp - ring.pc.xyz;
  let along = dot(toP, L);
  let perp = length(toP - along * L);
  let sh = select(1.0, 0.06, along < 0.0 && perp < ring.light.w);
  let n = normalize(in.wn);
  let V = normalize(-in.wp);
  var col = ring.color.rgb * ringLight(n, V, L, alpha) * sh;
  if (ring.light2.w > 0.5) {
    let L2 = ring.light2.xyz;
    let a2 = dot(toP, L2);
    let sh2 = select(1.0, 0.06, a2 < 0.0 && length(toP - a2 * L2) < ring.light.w);
    col += ring.color.rgb * ringLight(n, V, L2, alpha) * sh2 * ring.lightC2.rgb;
  }
  return vec4f(col * frame.exposure, alpha);
}

// How a ring's particles send a sun's light to you (docs/rings.md), × their colour:
//   - from the lit side, reflected (by the sun's height over the plane), brighter still with the sun
//     right behind you (the opposition surge: no shadows to see);
//   - from the unlit side, only what comes through: its thin parts glow, its thick ones go dark;
//   - its fine dust scatters forward: looking toward the sun, the thin, dusty parts blaze (as Saturn's
//     rings seen from behind it). `alpha`: how opaque the ring is here.
fn ringLight(n: vec3f, V: vec3f, L: vec3f, alpha: f32) -> f32 {
  let nl = dot(n, L);
  let nv = dot(n, V);
  let sameSide = nl * nv > 0.0;
  let cosT = dot(-V, L); // (1: looking straight at the sun through it)
  let dust = 1.0 - smoothstep(0.2, 0.9, alpha);
  let g = 0.75;
  let d = 1.0 + g * g - 2.0 * g * cosT;
  let fwd = (1.0 - g * g) / (d * sqrt(d)) * 0.2; // (Henyey-Greenstein × 4π, 1 on average; ×0.2: ~1.7 looking near the sun)
  let surge = pow(max(-cosT, 0.0), 40.0) * 0.4;
  let reflected = (0.35 + 0.65 * abs(nl)) * (1.0 + surge);
  let through = (0.12 + 0.6 * (1.0 - alpha)) * abs(nl) + 0.08;
  return select(through, reflected, sameSide) + dust * fwd * (0.4 + 0.6 * (1.0 - alpha));
}
