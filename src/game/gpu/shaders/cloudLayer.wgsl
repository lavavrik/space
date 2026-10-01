// The cloud layer (render/shaders/cloudLayer.frag.glsl): a shell at the deck's height, seen from above
// or below. Each pixel meets the smooth sphere along its ray (not the mesh's facets), samples the baked
// cover there plus finer octaves, lights it, and hazes it with the air in between. Over high ground
// the shell is lifted as the volumetric clouds are (clouds.wgsl cloudLiftAt), and the pixel's depth is
// the lifted point's: at the mesh's, from orbit the highlands' terrain chunks hid it.
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

struct FragOut {
  @location(0) col: vec4f,
  @builtin(frag_depth) depth: f32,
}

@fragment
fn fs(in: Out) -> FragOut {
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
  let near = abs(t0 - dist) < abs(t1 - dist);
  var t = select(t1, t0, near);
  if (t <= 0.0) { discard; }
  let toL = mat3x3f(world.toLocal[0].xyz, world.toLocal[1].xyz, world.toLocal[2].xyz);
  // lifted over high ground: the same side of the sphere, a little higher
  let lift = cloudLiftAt(toL * normalize(dir * t - C));
  if (lift > 0.0) {
    let rl = world.cloudR + lift;
    let dl = b * b - (dot(C, C) - rl * rl);
    if (dl >= 0.0) { t = select(b + sqrt(dl), b - sqrt(dl), near); }
    if (t <= 0.0) { discard; }
  }
  let P = dir * t;
  let n = normalize(P - C);
  let pw = toL * n;
  let p = cloudDir(pw);
  let fw = max(length(fwidth(p)), 1e-9);
  let oct = i32(clamp(log2(0.5 / (2.0 * fw)) + 1.0, 3.0, 11.0));
  var raw = cloudMap(pw);
  var a = 0.5 * pow(0.5, 7.0);
  var k = 2.0 * pow(2.03, 7.0);
  for (var i = 7; i < 11; i++) {
    if (i >= oct) { break; }
    raw += a * tnoise(p * k + f32(i) * 3.1);
    a *= 0.5;
    k *= 2.03;
  }
  // shaped as the volumetric clouds are (clouds.wgsl weatherCover): a system's heart a sheet, its
  // thinner edges broken into clumps with clear gaps, each opaque with a crisp, eroded edge. By
  // the cover alone, as an opacity, thin cover was a faint veil spread wide (purplish, the ground
  // through it), and the systems faded out at their edges
  let cov0 = cloudCover(raw);
  if (cov0 < 0.004) { discard; }
  let pm = fw * world.cloudR; // (m: a pixel's footprint)
  let wc = weatherCover(p * world.cloudR, cov0, 1.0 - smoothstep(1500.0, 6000.0, pm));
  // erosion: billows a couple of km across (as vclouds.wgsl's), strongest at the edges; under a
  // pixel, their mean
  let kb = p * world.cloudR * 0.00045 + vec3f(0.0, world.time * 3e-4, 0.0);
  let nv = 1.0 - smoothstep(600.0, 2500.0, pm);
  var nb = 0.0;
  if (nv > 0.01) { nb = (0.65 * tnoise(kb) + 0.35 * tnoise(kb * 3.1)) * nv; }
  let bite = mix(0.75, 0.45, smoothstep(0.5, 0.9, wc.cov));
  let dens = clamp((wc.cov - (1.0 - wc.cov) * (bite - bite * nb)) * 3.0, 0.0, 1.0);
  let cov = mix(wc.cov, dens, mix(0.5, 1.0, nv)); // (unresolved: between the eroded and the plain)
  if (cov < 0.004) { discard; }
  let L = normalize(world.light.xyz);
  let lit = clamp(dot(n, L) * 1.05 + 0.05, 0.0, 1.0) * sunShade(P - C);
  let below = length(C) < world.cloudR;
  var light = lit * atSunlight(P, L);
  var haze = atInscatter(dir * atSpan(dir).x, P, L, 5);
  // a pair's second sun, in its colour (docs/binaries.md)
  if (world.light2.w > 0.5) {
    let L2 = normalize(world.light2.xyz);
    light += clamp(dot(n, L2) * 1.05 + 0.05, 0.0, 1.0) * atSunlight(P, L2) * world.lightC2.rgb;
    haze += atInscatter(dir * atSpan(dir).x, P, L2, 5) * world.lightC2.rgb;
  }
  let col = vec3f(0.97) * light * select(1.0, 0.3 + 0.55 * (1.0 - cov), below);
  let clip = frame.viewProj * vec4f(P, 1.0);
  return FragOut(vec4f((col * atTrans + haze) * frame.twilight, cov * 0.95 * (1.0 - world.deckHide)), clamp(clip.z / clip.w, 0.0, 1.0));
}
