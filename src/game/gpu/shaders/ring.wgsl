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
  let lit = 0.35 + 0.65 * abs(dot(normalize(in.wn), L));
  return vec4f(ring.color.rgb * lit * sh * frame.exposure, alpha);
}
