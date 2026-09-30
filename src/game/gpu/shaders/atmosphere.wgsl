// The sky: a shell at the top of a world's air, drawn from inside (render/shaders/atmosphere.frag.glsl).
// Each pixel adds the light scattered along its ray through the air (up to the ground) and dims
// what's behind in proportion to how bright it is (blend: src + dst × alpha), so daylight hides the stars.
// #include frame
// #include world
// #include atmo
// #include noise
// #include ringband
// #include shadow

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
}

@vertex
fn vs(@location(0) position: vec3f) -> Out {
  var o: Out;
  // the shell: the unit sphere at the top of the air (a hair wider, so its facets cover the true sphere)
  let wp = world.atC.xyz + (world.rotN * vec4f(position, 0.0)).xyz * world.atTop * 1.001;
  o.wp = wp;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let dir = normalize(in.wp);
  var s = atSpan(dir);
  if (s.y <= s.x) { discard; }
  let C = world.atC.xyz;
  let b = dot(dir, C);
  let cg = dot(C, C) - atR() * atR();
  let dg = b * b - cg;
  let ground = dg > 0.0 && b - sqrt(dg) > 0.0;
  if (ground) { s.y = min(s.y, b - sqrt(dg)); }
  // an eclipse or the ring's shadow dims the sky too: taken where the ray meets the ground, or
  // halfway along it through the air
  let at = select(0.5 * (s.x + s.y), s.y, ground);
  var sky = atInscatter(dir * s.x, dir * s.y, normalize(world.light.xyz), 8) * sunShade(dir * at - C);
  // a pair's second sun lights the air too, in its colour (docs/binaries.md)
  let two = world.light2.w > 0.5;
  let L2 = normalize(world.light2.xyz + vec3f(0.0, 1e-9, 0.0));
  if (two) { sky += atInscatter(dir * s.x, dir * s.y, L2, 8) * world.lightC2.rgb; }
  // the night sky's own faint glow (airglow, starlight in the air): as much as there's air along the
  // ray, where the sun's gone (at night the sky was pitch black, and so was everything under it)
  let up2 = select(0.0, min(1.0, 4.0 * max(world.lightC2.r, max(world.lightC2.g, world.lightC2.b))), two);
  let night = (1.0 - smoothstep(-0.15, 0.1, dot(normalize(-C), normalize(world.light.xyz)))) * (1.0 - smoothstep(-0.15, 0.1, dot(normalize(-C), L2)) * up2);
  sky += vec3f(0.03, 0.045, 0.09) * (1.0 - dot(atTrans, vec3f(0.333))) * night;
  let lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  let keep = clamp(1.0 - lum * 5.0, 0.0, 1.0) * dot(atTrans, vec3f(0.333));
  return vec4f(sky, keep);
}
