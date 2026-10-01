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
  if (two) { sky += atInscatter(dir * s.x, dir * s.y, L2, 8) * world.lightC2.rgb * sunShade2(dir * at - C); }
  // the night sky's own faint glow (airglow, starlight in the air): as much as there's air along the
  // ray, where the sun's gone (at night the sky was pitch black, and so was everything under it)
  let up2 = select(0.0, min(1.0, 4.0 * max(world.lightC2.r, max(world.lightC2.g, world.lightC2.b))), two);
  let night = (1.0 - smoothstep(-0.15, 0.1, dot(normalize(-C), normalize(world.light.xyz)))) * (1.0 - smoothstep(-0.15, 0.1, dot(normalize(-C), L2)) * up2);
  sky += vec3f(0.03, 0.045, 0.09) * (1.0 - dot(atTrans, vec3f(0.333))) * night;
  // twilight's glow (atmo.wgsl atTwilight), as much as there's air along the ray
  let upC = normalize(-C);
  var tw = atTwilight(upC, normalize(world.light.xyz), dir);
  if (two) { tw += atTwilight(upC, L2, dir) * world.lightC2.rgb; }
  sky += tw * (1.0 - dot(atTrans, vec3f(0.333)));
  let lum = dot(sky, vec3f(0.2126, 0.7152, 0.0722));
  var keep = clamp(1.0 - lum * 5.0, 0.0, 1.0) * dot(atTrans, vec3f(0.333));
  // the suns' discs, seen through the air: the sky hides what's behind it once it's bright (the stars
  // by day), and that hid the star's own disc (star.wgsl) too. Here, the disc as it would show
  // there, reddened and dimmed by the air along the ray, brighter the brighter the sky round it (as
  // bright as star.wgsl's against a dark one, where the shell's edge crosses it in space)
  let k = mix(1.2, 5.0, 1.0 - clamp(1.0 - lum * 5.0, 0.0, 1.0));
  let d1 = sunDiscAt(dir, C + world.sunC.xyz, world.sunC.w);
  var d2 = 0.0;
  var col2 = vec3f(0.0);
  if (two) {
    d2 = sunDiscAt(dir, C + world.sunC2.xyz, world.sunC2.w);
    col2 = world.lightC2.rgb / max(max(world.lightC2.r, world.lightC2.g), max(world.lightC2.b, 1e-6));
  }
  sky += (vec3f(d1) + col2 * d2) * k * atTrans;
  keep *= 1.0 - max(step(1e-4, d1), step(1e-4, d2));
  // airglow: a thin shell of faint green light high in the air (oxygen, ~95 km on Earth: here at
  // 85 % of the way to the air's top), at night: seen edge-on its path through the shell is ~80×
  // its thickness, so the limb of the night side carries a faint green line, as from orbit
  if (world.ozone > 0.0) {
    let rA = mix(atR(), world.atTop, 0.85);
    let th = (world.atTop - atR()) * 0.04;
    let pIn = shellPath(b, cg + atR() * atR(), rA + th, s.y) - shellPath(b, cg + atR() * atR(), rA - th, s.y);
    let upA = normalize(dir * clamp(b, s.x, s.y) - C);
    let nA = smoothstep(-0.05, -0.2, dot(upA, normalize(world.light.xyz)));
    sky += vec3f(0.35, 1.0, 0.45) * 9e-8 * pIn * nA * min(world.ozone, 1.0);
  }
  // (twilight: the eye adapted, GpuRenderer; the sky isn't × exposure otherwise)
  sky *= frame.twilight;
  return vec4f(sky, keep);
}

// how far the ray (b = dir·C, CC = |C|², the camera inside nothing in particular) runs inside the
// sphere of radius r, up to tMax
fn shellPath(b: f32, CC: f32, r: f32, tMax: f32) -> f32 {
  let disc = b * b - (CC - r * r);
  if (disc <= 0.0) { return 0.0; }
  let q = sqrt(disc);
  return max(min(b + q, tMax) - max(b - q, 0.0), 0.0);
}

// A sun's disc at `dir` (its centre P, camera-relative, radius r): 0 off it, limb-darkened as
// star.wgsl's, its edge smoothed over a pixel
fn sunDiscAt(dir: vec3f, P: vec3f, r: f32) -> f32 {
  let d = max(length(P), 1e-6);
  let toS = P / d;
  let th = length(cross(dir, toS)); // (the angle off its centre, small)
  let w = max(fwidth(th), 1e-7); // (before any branch: derivatives need the whole quad)
  let thR = r / d;
  if (r <= 0.0 || d <= r || dot(dir, toS) <= 0.0) { return 0.0; }
  let cov = 1.0 - smoothstep(thR - w, thR + w, th);
  let x = clamp(th / thR, 0.0, 1.0);
  let mu = sqrt(1.0 - x * x);
  return cov * (0.35 + 0.65 * pow(mu, 0.45));
}
