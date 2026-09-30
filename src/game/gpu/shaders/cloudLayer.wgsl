// The cloud layer (render/shaders/cloudLayer.frag.glsl): a shell at the deck's height, seen from above
// or below. Each pixel meets the smooth sphere along its ray (not the mesh's facets), samples the baked
// cover there plus finer octaves, lights it, and hazes it with the air in between.
diagnostic(off, derivative_uniformity);
// #include frame
// #include world
// #include noise
// #include noise3d
// #include clouds
// #include ringband
// #include shadow
// #include atmo

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
}

@vertex
fn vs(@location(0) position: vec3f) -> Out {
  var o: Out;
  let wp = world.atC.xyz + (world.rotN * vec4f(position, 0.0)).xyz * world.cloudR * 1.001;
  o.wp = wp;
  o.pos = frame.viewProj * vec4f(wp, 1.0);
  return o;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let dist = length(in.wp);
  let dir = in.wp / dist;
  let C = world.atC.xyz;
  let b = dot(dir, C);
  let c = dot(C, C) - world.cloudR * world.cloudR;
  let disc = b * b - c;
  if (disc < 0.0) { discard; }
  let sq = sqrt(disc);
  let t0 = b - sq;
  let t1 = b + sq;
  let t = select(t1, t0, abs(t0 - dist) < abs(t1 - dist));
  if (t <= 0.0) { discard; }
  let P = dir * t;
  let n = normalize(P - C);
  let p = cloudDir(mat3x3f(world.toLocal[0].xyz, world.toLocal[1].xyz, world.toLocal[2].xyz) * n);
  let fw = max(length(fwidth(p)), 1e-9);
  let oct = i32(clamp(log2(0.5 / (2.0 * fw)) + 1.0, 3.0, 11.0));
  var raw = textureSampleLevel(cloudTex, cloudSamp, p, 0.0).r;
  var a = 0.5 * pow(0.5, 7.0);
  var k = 2.0 * pow(2.03, 7.0);
  for (var i = 7; i < 11; i++) {
    if (i >= oct) { break; }
    raw += a * tnoise(p * k + f32(i) * 3.1);
    a *= 0.5;
    k *= 2.03;
  }
  let cov = cloudCover(raw);
  if (cov < 0.004) { discard; }
  let L = normalize(world.light.xyz);
  let lit = clamp(dot(n, L) * 1.05 + 0.05, 0.0, 1.0) * sunShade(P - C);
  let below = length(C) < world.cloudR;
  let col = vec3f(0.97) * lit * atSunlight(P, L) * select(1.0, 0.3 + 0.55 * (1.0 - cov), below);
  let haze = atInscatter(dir * atSpan(dir).x, P, L, 5);
  return vec4f(col * atTrans + haze, cov * 0.95 * (1.0 - world.deckHide));
}
