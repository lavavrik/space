// Planets and moons (render/shaders/planet.*.glsl): from afar the unit sphere, scaled and turned (vs);
// up close the terrain's LOD chunks (vsChunk; gpu/terrain.ts), their heights, normals and shadows
// baked per vertex (terrainBake.wgsl) and only the finer octaves worked out here. Per pixel: the terrain height (as bumps), the
// surface by world type (gas and ice giants' bands, rock, desert, oceans and land, lava, ice), the
// cloud layer's shadow, sunlight through the air, city lights at night, then the air's haze.
diagnostic(off, derivative_uniformity);
// #include frame
// #include world
// #include chunk
// #include noise
// #include noise3d
// #include terrain
// #include atmo
// #include clouds
// #include city
// #include ringband
// #include shadow

// the chunk's bake (terrainBake.wgsl): two vec4s per grid vertex
@group(2) @binding(1) var<storage, read> bake: array<vec4f>;

struct Out {
  @builtin(position) pos: vec4f,
  @location(0) obj: vec3f,
  @location(1) wn: vec3f,
  @location(2) wp: vec3f,
  @location(3) offDir: vec3f,   // chunks: direction minus the chunk centre's (terrain.wgsl terrQ)
  @location(4) haze: vec3f,     // chunks: the air's haze, its transmittance and the sunlight, per vertex
  @location(5) hazeT: vec3f,
  @location(6) sun: vec3f,
  @location(7) t: vec4f,        // skirt (0 surface … 1 down a skirt), octaves the geometry has (0: far sphere), shadow, hc
  @location(8) mask: f32,       // the range mask the geometry has
  @location(9) sun2: vec3f,     // chunks: a second sun's light through the air, per vertex (docs/binaries.md)
}

// A pair's second sun (world.wgsl light2; docs/binaries.md): whether there is one, its direction,
// and how strong it is at most (its colour × strength's largest channel)
fn has2() -> bool { return world.light2.w > 0.5; }
fn L2dir() -> vec3f { return normalize(world.light2.xyz + vec3f(0.0, 1e-9, 0.0)); }
fn k2() -> f32 { return max(world.lightC2.r, max(world.lightC2.g, world.lightC2.b)); }

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> Out {
  var o: Out;
  let wp = world.model * vec4f(position, 1.0);
  o.obj = position;
  o.wp = wp.xyz;
  o.wn = normalize((world.rotN * vec4f(normal, 0.0)).xyz);
  o.t = vec4f(0.0, 0.0, 1.0, 0.0);
  o.sun2 = vec3f(0.0);
  o.pos = frame.viewProj * wp;
  return o;
}

// A terrain chunk: `position` is the undisplaced point relative to the chunk's centre (m), `dir` its
// unit direction, `grid` its place in the chunk's grid (skirt vertices share their edge vertex's).
@vertex
fn vsChunk(@location(0) position: vec3f, @location(1) dir: vec3f, @location(2) grid: vec2f, @location(3) skirt: f32) -> Out {
  var o: Out;
  let gi = u32(grid.y + 0.5) * u32(chunk.gridW + 0.5) + u32(grid.x + 0.5);
  let A = bake[2u * gi];
  let B = bake[2u * gi + 1u];
  let pos = position + dir * (A.w - skirt * chunk.skirtD);
  let wp = chunkModel() * vec4f(pos, 1.0);
  o.obj = dir;
  o.wp = wp.xyz;
  o.wn = normalize((world.rotN * vec4f(A.xyz, 0.0)).xyz);
  o.offDir = position / world.radius;
  o.t = vec4f(skirt, chunk.vOct, B.x, B.y);
  o.mask = B.z;
  // the air between the camera and here varies smoothly: per vertex, not per pixel (at the ground:
  // skirt vertices hang far below it, where the air's density would blow up)
  let ground = (chunkModel() * vec4f(pos + dir * skirt * chunk.skirtD, 1.0)).xyz;
  let L = normalize(world.light.xyz);
  let vd = normalize(ground);
  o.haze = atInscatter(vd * atSpan(vd).x, ground, L, 5);
  o.hazeT = atTrans;
  o.sun = atSunlight(ground, L);
  o.sun2 = vec3f(0.0);
  if (has2()) {
    o.haze += atInscatter(vd * atSpan(vd).x, ground, L2dir(), 5) * world.lightC2.rgb;
    o.sun2 = atSunlight(ground, L2dir()) * world.lightC2.rgb * B.w; // (B.w: the mountains' shadow from it)
  }
  o.pos = frame.viewProj * wp;
  return o;
}

fn toLocal3() -> mat3x3f { return mat3x3f(world.toLocal[0].xyz, world.toLocal[1].xyz, world.toLocal[2].xyz); }

// bump mapping from a height field H (m) over the surface (Mikkelsen): the far sphere's derivatives
// come from the object-space position, turned to world axes (camera-relative positions are too
// coarse across the system)
fn bumpN(N: vec3f, H: f32, obj: vec3f, wp: vec3f, terr: bool) -> vec3f {
  let toWorld = transpose(toLocal3());
  var dpx = toWorld * dpdx(obj * world.radius);
  var dpy = toWorld * dpdy(obj * world.radius);
  if (terr) {
    // chunks are near: camera-relative positions are precise
    dpx = dpdx(wp);
    dpy = dpdy(wp);
  }
  let dhx = dpdx(H);
  let dhy = dpdy(H);
  let r1 = cross(dpy, N);
  let r2 = cross(N, dpx);
  let det = dot(dpx, r1);
  if (abs(det) < 1e-30) { return N; }
  let g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}

// ---- Gas and ice giants (docs/giants.md) ----
// Bands that shear past each other: each latitude turns at its own rate (jets, alternating east and
// west), the pattern carried along by it. Sheared for ever it would smear into streaks, so it's
// read twice, carried for up to GIANT_FLOW_T seconds each, a half-period apart, and cross-faded
// (flow noise): it keeps flowing and never smears. Turbulence where neighbouring bands shear
// hardest, and storms: ovals that ride their band, their insides swirling.
const GIANT_JET: f32 = 1.2e-5;    // rad/s at the fastest jets (~1 km/s on a Jupiter-sized world)
const GIANT_FLOW_T: f32 = 2400.0; // s
const GIANT_STORMS: i32 = 6;

fn giantJets(lat: f32, gas: bool, seed: f32) -> f32 {
  let k = select(5.0, 11.0, gas);
  return GIANT_JET * (0.7 * sin(lat * k + seed) + 0.3 * sin(lat * k * 2.3 + seed * 2.0)) * select(0.6, 1.0, gas);
}

fn rotAbout(v: vec3f, axis: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

fn ghash(n: f32) -> f32 { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }

// the bands' colour at `q` (a point on the unit sphere, where the flow has carried the pattern from)
fn giantBands(q: vec3f, lat: f32, seed: f32, gas: bool, oct: i32, dark: bool) -> vec3f {
  let sp = q * 1.6 + vec3f(seed * 1.7, seed * 2.3, seed * 0.9);
  let w = fbmF(vec3f(sp.x * 1.2, sp.y * 5.0, sp.z * 1.2), min(oct, 5));
  // (waviness along the band edges, more where the jets shear)
  let k = select(5.0, 11.0, gas);
  let shear = abs(cos(lat * k + seed));
  let latq = q.y + w * select(0.025, 0.07, gas) * (0.6 + 0.8 * shear);
  let b1 = sin(latq * select(9.0, 26.0, gas) + seed) * 0.5 + 0.5;
  let b2 = sin(latq * select(21.0, 63.0, gas) + seed * 3.0) * 0.5 + 0.5;
  var c = mix(world.pa.rgb, world.pb.rgb, mix(0.5, b1, select(0.55, 1.0, gas)));
  c = mix(c, world.pc.rgb, b2 * select(0.2, 0.35, gas));
  if (!dark) {
    // turbulence: fine streaks along the bands, and eddies where they shear
    let turb = fbmF(sp * vec3f(3.0, 14.0, 3.0) + w * 2.0, min(oct, 7));
    let eddy = fbmF(sp * 7.0 + vec3f(turb * 3.0), min(oct, 5));
    c *= 0.9 + select(0.12, 0.22, gas) * turb + select(0.06, 0.16, gas) * eddy * shear;
    c = mix(c, world.pc.rgb, clamp(eddy * shear * select(0.3, 0.6, gas), 0.0, 0.4));
  }
  return c;
}

fn giantSurface(p: vec3f, seed: f32, gas: bool, oct: i32, dark: bool) -> vec3f {
  let t = world.time;
  // storms first: each swirls the pattern round its centre, riding its band
  var q = p;
  var core = 0.0;
  var ring = 0.0;
  let n = select(2, GIANT_STORMS, gas);
  for (var i = 0; i < n; i++) {
    let fi = f32(i) + seed * 13.0;
    let big = i == 0;
    let slat = (ghash(fi) - 0.5) * select(1.1, 1.3, big);
    let slon = ghash(fi + 7.0) * 6.2832 + giantJets(slat, gas, seed) * t;
    let cy = sin(slat);
    let ca = cos(slat);
    let c = vec3f(ca * cos(slon), cy, ca * sin(slon));
    let r = select(select(0.025, 0.05, ghash(fi + 3.0) > 0.6), select(0.09, 0.14, gas), big);
    // an oval: twice as long as it's high (along the band)
    let east = normalize(vec3f(-sin(slon), 0.0, cos(slon)));
    let rel = p - c;
    let de = dot(rel, east);
    let dn = dot(rel, vec3f(0.0, 1.0, 0.0) - c * cy);
    let d = sqrt(de * de / 4.0 + dn * dn) / r;
    let f = exp(-d * d * 1.5);
    // (anticyclonic in the south, cyclonic in the north: turning with its own spin)
    q = rotAbout(q, c, f * (2.5 + t * 3e-4) * select(-1.0, 1.0, slat > 0.0));
    core = max(core, smoothstep(1.0, 0.55, d) * select(0.55, 0.85, big));
    ring = max(ring, smoothstep(0.6, 1.0, d) * smoothstep(1.35, 1.0, d) * select(0.25, 0.4, big));
  }
  // the flow: read twice, carried along a half-period apart, cross-faded
  let lat = asin(clamp(p.y, -1.0, 1.0));
  let om = giantJets(lat, gas, seed);
  let ph1 = fract(t / GIANT_FLOW_T);
  let ph2 = fract(t / GIANT_FLOW_T + 0.5);
  let w1 = 1.0 - abs(ph1 * 2.0 - 1.0);
  let c1 = giantBands(rotAbout(q, vec3f(0.0, 1.0, 0.0), -om * ph1 * GIANT_FLOW_T), lat, seed, gas, oct, dark);
  let c2 = giantBands(rotAbout(q, vec3f(0.0, 1.0, 0.0), -om * ph2 * GIANT_FLOW_T), lat, seed, gas, oct, dark);
  var col = mix(c2, c1, w1);
  // the storms' colour: a dark (or red) oval with a pale collar
  col = mix(col, world.pd.rgb, core);
  col = mix(col, world.pc.rgb * 1.1, ring);
  return col;
}

/** The night's own light on the ground (starlight, airglow), in daylight's units. */
const NIGHT_AMB: f32 = 0.15; // (the ground's dark: 0.02 of it was lost in black)

// Water (docs/water.md). Waves: three octaves of moving noise, 60, 24 and 9.6 m long (their noise
// periods, 8 × each, all divide worlds.ts WAVE_PERIOD), drifting at deep water's speed for their
// length, each fading out below a few pixels. Returns the waves' slope (the height's gradient, the
// world's frame) and the share of it resolved here (1 up close, 0 where they're all sub-pixel).
// The slope is from the noise itself (central differences): from screen-space derivatives it was
// as coarse as a pixel quad, and the glints shimmered in moiré. Their clock is world.waveO.w, the
// time wrapped to an hour: the sim's own, ~2.4 million s at day 28, has float32 steps of 0.25 s, and
// the waves moved in jerks.
const WAVE_L = array<f32, 3>(60.0, 24.0, 9.6);
fn waterWaves(wp: vec3f, fw: f32) -> vec4f {
  let q = toLocal3() * wp + world.waveO.xyz; // (m, the world's frame, small near you)
  let pm = max(fw * world.radius, 1e-3);      // m a pixel
  let wind = normalize(vec3f(1.0, 0.0, 0.6));
  let t = world.waveO.w;
  var g = vec3f(0.0);
  var seen = 0.0;
  for (var i = 0; i < 3; i++) {
    let l = WAVE_L[i];
    let vis = smoothstep(3.0, 8.0, l / pm);
    seen += vis / 3.0;
    if (vis < 0.01) { continue; }
    let c = sqrt(9.81 * l / 6.2832); // deep water's phase speed
    let u = q / l + wind * (c / l) * t + vec3f(f32(i) * 3.7);
    let e = 0.06; // (of a wavelength: the noise's texels are 1/8)
    let d = vec3f(tnoise(u + vec3f(e, 0.0, 0.0)) - tnoise(u - vec3f(e, 0.0, 0.0)), tnoise(u + vec3f(0.0, e, 0.0)) - tnoise(u - vec3f(0.0, e, 0.0)), tnoise(u + vec3f(0.0, 0.0, e)) - tnoise(u - vec3f(0.0, 0.0, e))) / (2.0 * e);
    g += 0.03 * vis * d; // (height 0.03 l × noise(q / l): its gradient is 0.03 × the noise's)
  }
  return vec4f(g, seen);
}

// Climate on Earth-like and ocean worlds' land (docs/terrain.md). `e`: height over the sea (terrain
// units, ~0.6 at the snow line); `lat`: |sine of latitude|.
//   - warmth: falling with latitude and height;
//   - wetness: a continent-scale pattern, less in dry belts ~25–35° from the equator (where the
//     world's air sinks: its deserts), more near the coasts;
//   - the cover: desert / steppe / grassland where it's dry, savanna / forest / jungle where wet,
//     tundra and taiga where cold.
fn landTemp(e: f32, lat: f32) -> f32 { return 1.0 - smoothstep(0.1, 0.9, lat) - e * 0.9; }
fn landMoist(p: vec3f, e: f32, lat: f32, seed: f32) -> f32 {
  // (continents' climates ~2,500 km across, regions ~500 km, and patches ~100 km: by the first alone
  // a view from the ground was one cover to the horizon)
  let m = 0.5 + 0.35 * snoise(p * 2.6 + vec3f(seed * 1.9, 7.0, seed)) + 0.2 * snoise(p * 11.0 + vec3f(2.0, seed, 5.0)) + 0.12 * snoise(p * 48.0 + vec3f(seed, 3.0, 1.0));
  let belt = exp(-pow((lat - 0.5) / 0.13, 2.0));
  return m - 0.4 * belt + 0.25 * (1.0 - smoothstep(0.0, 0.1, e));
}
fn landClimate(p: vec3f, e: f32, lat: f32, seed: f32) -> vec3f {
  let t = landTemp(e, lat);
  let m = landMoist(p, e, lat, seed);
  let cool = smoothstep(0.75, 0.35, t); // (0 hot … 1 temperate)
  let dry = mix(vec3f(0.78, 0.64, 0.43), vec3f(0.56, 0.53, 0.34), cool); // desert … steppe
  let mid = mix(vec3f(0.55, 0.5, 0.27), vec3f(0.33, 0.42, 0.2), cool); // savanna … grassland
  let wet = mix(vec3f(0.1, 0.25, 0.08), vec3f(0.15, 0.27, 0.14), cool); // jungle … forest
  var c = mix(dry, mid, smoothstep(0.15, 0.4, m));
  c = mix(c, wet, smoothstep(0.45, 0.7, m));
  // cold: taiga where it's wet, tundra where not
  let taiga = mix(vec3f(0.45, 0.43, 0.37), vec3f(0.17, 0.24, 0.17), smoothstep(0.3, 0.6, m));
  return mix(c, taiga, smoothstep(0.3, 0.05, t));
}

// The ground up close (docs/terrain.md): what the terrain's octaves can't give a metre-scale view.
// In the near-camera frame the waves use (world.waveO: small, precise numbers), so every length's
// noise period (8 ×) divides worlds.ts WAVE_PERIOD. Each layer fades in only where it's over a few
// pixels:
//   - patches of soil and growth, 48 and 9.6 m: brightness and a drier or greener tint;
//   - bare rock where it's steep (by the ground's own slope);
//   - stones: dark, a little rough, scattered at 2.4 and 0.6 m;
//   - grain: fine brightness at 2.4 and 0.6 m, and small bumps that catch the light (their slope
//     from the noise, as the waves').
// Returns the colour and the normal.
struct Ground {
  col: vec3f,
  N: vec3f,
}
fn groundDetail(col0: vec3f, N0: vec3f, up: vec3f, wp: vec3f, fw: f32, wet: bool) -> Ground {
  let q = toLocal3() * wp + world.waveO.xyz;
  let pm = max(fw * world.radius, 1e-3);
  let vis = vec4f(smoothstep(vec4f(2.0), vec4f(8.0), vec4f(48.0, 9.6, 2.4, 0.6) / pm));
  var col = col0;
  var N = N0;
  if (vis.x < 0.01) { return Ground(col, N); }
  // patches: brightness, and toward dry or green
  let n1 = tnoise(q / 48.0 + 1.3);
  let n2 = tnoise(q / 9.6 + 7.1);
  col *= 1.0 + vis.x * 0.22 * n1 + vis.y * 0.12 * n2;
  let lum = dot(col, vec3f(0.333));
  let dry = vec3f(lum * 1.15, lum * 1.0, lum * 0.7);
  let green = col * vec3f(0.85, 1.08, 0.8);
  col = mix(col, select(dry, green, n2 > 0.0), vis.y * 0.25 * abs(n2) * select(1.0, 0.0, !wet));
  // small bumps: their slope from fine noise (central differences, as the waves')
  var g = vec3f(0.0);
  for (var i = 0; i < 2; i++) {
    let l = select(0.6, 2.4, i == 0);
    let v = select(vis.w, vis.z, i == 0);
    if (v < 0.01) { continue; }
    let u = q / l + vec3f(f32(i) * 5.3);
    let e = 0.06;
    let d = vec3f(tnoise(u + vec3f(e, 0.0, 0.0)) - tnoise(u - vec3f(e, 0.0, 0.0)), tnoise(u + vec3f(0.0, e, 0.0)) - tnoise(u - vec3f(0.0, e, 0.0)), tnoise(u + vec3f(0.0, 0.0, e)) - tnoise(u - vec3f(0.0, 0.0, e))) / (2.0 * e);
    g += 0.06 * v * d;
  }
  let gw = transpose(toLocal3()) * g;
  N = normalize(N - (gw - N * dot(gw, N)));
  // bare rock where it's steep (the ground's own slope, not the bumps': by those, rock everywhere)
  let steep = 1.0 - dot(N0, up);
  let rock = vec3f(0.36, 0.34, 0.31) * (0.85 + 0.3 * n2);
  col = mix(col, rock, smoothstep(0.18, 0.4, steep + 0.08 * n1) * select(0.6, 0.9, wet));
  // stones, and fine grain
  let s1 = tnoise(q / 2.4 + 3.3);
  let s2 = tnoise(q / 0.6 + 9.1);
  let stones = max(smoothstep(0.32, 0.4, s1) * vis.z, smoothstep(0.36, 0.44, s2) * vis.w);
  col = mix(col, rock * 0.75, stones * 0.8);
  col *= 1.0 + 0.1 * (vis.z * s1 + vis.w * s2);
  return Ground(col, N);
}

// the sky seen in the water, along `R` from `Pc` (relative to the world's centre): the air's own
// light out to its top (as the sky shell draws it), each sun's, dimmed by their eclipses
fn waterSky(Pc: vec3f, R: vec3f, L: vec3f, two: bool, L2: vec3f, shade: f32) -> vec3f {
  if (world.atOn < 0.5) { return vec3f(0.0); } // (no air: black space in the water)
  let b = dot(R, Pc);
  let t = -b + sqrt(max(b * b - (dot(Pc, Pc) - world.atTop * world.atTop), 0.0));
  var c = atInscatterC(Pc, Pc + R * t, L, 4) * shade;
  if (two) { c += atInscatterC(Pc, Pc + R * t, L2, 4) * world.lightC2.rgb; }
  // the clouds in it: where the ray crosses the cloud deck, its cover there, lit as the deck is
  // (cloudLayer.wgsl), over the sky (a mirrored deck, one lookup: the volumetric clouds' shapes
  // aren't marched again)
  if (world.cloudH > 0.0 && length(Pc) < world.cloudR) {
    let tc = -b + sqrt(max(b * b - (dot(Pc, Pc) - world.cloudR * world.cloudR), 0.0));
    let Pk = Pc + R * tc;
    let nk = normalize(Pk);
    let cov = cloudCover(cloudMap(toLocal3() * nk));
    if (cov > 0.004) {
      var lit = clamp(dot(nk, L) * 1.05 + 0.05, 0.0, 1.0) * atSunlightC(Pk, L) * shade;
      if (two) { lit += clamp(dot(nk, L2) * 1.05 + 0.05, 0.0, 1.0) * atSunlightC(Pk, L2) * world.lightC2.rgb; }
      // (seen from under it: its underside, greyer the thicker it is)
      c = mix(c, vec3f(0.9) * lit * (0.35 + 0.5 * (1.0 - cov)) + c * 0.3, cov * 0.9);
    }
  }
  return c;
}

// a sun's glitter in the water: the mirror lobe (normalised Blinn-Phong, sharpness n) × Fresnel at it,
// × GLINT_K: the sun's disc is thousands of times brighter than what it lights, so even at the 2 %
// a high sun's light reflects straight up the glints blaze (and bloom); at 1 they read as pale flecks
const GLINT_K: f32 = 8.0;
fn waterGlint(Nw: vec3f, N: vec3f, V: vec3f, L: vec3f, n: f32) -> f32 {
  if (dot(N, L) <= 0.0) { return 0.0; }
  let H = normalize(L + V);
  let F = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  return GLINT_K * (n + 8.0) / 25.13 * pow(max(dot(Nw, H), 0.0), n) * F;
}

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let terr = in.t.y > 0.5;
  // Skirts hang below every chunk's edge to hide the cracks between levels; a crack only ever shows
  // a skirt's top, so that keeps the full shader and the rest gets plain lit ground colour.
  if (terr && in.t.x > 0.5) {
    let d0 = clamp(dot(normalize(in.wn), normalize(world.light.xyz)) * 1.05 + 0.03, 0.0, 1.0);
    let d02 = select(0.0, clamp(dot(normalize(in.wn), L2dir()) * 1.05 + 0.03, 0.0, 1.0), has2());
    let c0 = mix(world.pa.rgb, world.pb.rgb, 0.5) * (d0 * in.t.z * in.sun + d02 * in.sun2 + 0.0002);
    return vec4f((c0 * in.hazeT + in.haze) * frame.exposure, 1.0);
  }
  let p = normalize(in.obj);
  var N = normalize(in.wn);
  let V = normalize(-in.wp);
  let L = normalize(world.light.xyz);
  var ndl = dot(N, L);
  let ndl0 = ndl;
  // a pair's second sun (docs/binaries.md): its own diffuse, specular, sky light and haze; its
  // shadows come later. Night (the dark side's octaves, its ambient and city lights) is where both
  // are down, a weak one counting for less.
  let two = has2();
  let L2 = L2dir();
  let ndl20 = select(-1.0, dot(N, L2), two);
  let up2 = min(1.0, k2() * 4.0);
  let seed = world.seed;
  let sp = p * 1.6 + vec3f(seed * 1.7, seed * 2.3, seed * 0.9);
  let fw = max(length(fwidth(p)), 1e-9);
  var oct = min(world.oct, i32(clamp(log2(0.5 / (1.6 * fw)) / 1.02 + 1.0, 3.0, f32(T_OCT_MAX))));
  let ty = world.wtype;
  let dark = clamp(ndl * 1.05 + 0.03, 0.0, 1.0) < 0.002 && clamp(ndl20 * 1.05 + 0.03, 0.0, 1.0) * up2 < 0.002 && ty != 4;
  if (dark) { oct = min(oct, select(3, 8, world.city > 0.5)); }
  var col: vec3f;
  var emit = vec3f(0.0);
  var spec = 0.0;
  var det = 1.0;
  var elev = 0.0;
  var pop = 0.0;
  var seaDepth = 1e9; // (m: the water's depth here, for the surf)
  var snow = 0.0; // (its share here: blue in shade, sparkling in the sun)
  let A = world.pa.rgb;
  let B = world.pb.rgb;
  let C = world.pc.rgb;
  let D = world.pd.rgb;
  if (ty >= 6) {
    col = giantSurface(p, seed, ty == 6, oct, dark);
  } else {
    // only the octaves finer than the geometry are worked out here; the rest come baked
    tUseOff = terr;
    tOffDir = in.offDir;
    let hc = in.t.w;
    let seaOn = ty == 2 || ty == 3;
    let o0 = i32(in.t.y + 0.5);
    // (open sea whatever the finer octaves add: they're skipped, flat water)
    var h = hc;
    tDet = 0.0;
    tFw = fw;
    if (!(terr && seaOn && hc + terrRise(o0, oct) < world.sea)) { h = terrHFrom(p, o0, oct, hc, in.mask); }
    tFw = 0.0;
    tUseOff = false;
    elev = terrElev(h, world.sea, seaOn);
    N = bumpN(N, elev - terrElev(hc, world.sea, seaOn), in.obj, in.wp, terr);
    det = 1.0 + 0.1 * tDet;
    var h2 = 0.0;
    if (!dark) { h2 = fbmF(sp * 3.1 + 4.0, min(max(oct - 2, 3), 5)); }
    let lat = abs(p.y);
    // (cr: 1 − |noise|, slightly negative where the noise overshoots ±1, and pow of a negative is
    // NaN on NVIDIA (D3D): on rocky moons it blinked black blocks, bloom's low mips spreading one bad
    // pixel over a fifth of the screen; hence the max(…, 0) in each pow)
    if (ty == 0) {
      let cr = 1.0 - abs(snoise(sp * 5.0 + h));
      col = mix(A, B, sm(-0.5, 0.6, h));
      col *= 0.78 + 0.35 * pow(max(cr, 0.0), 4.0);
      col = mix(col, C, sm(0.25, 0.7, h2) * 0.4);
    } else if (ty == 1) {
      let d = sin((p.x + p.z) * 90.0 + h * 14.0) * 0.5 + 0.5;
      col = mix(A, B, sm(-0.4, 0.5, h));
      col = mix(col, C, d * 0.12 + sm(0.35, 0.8, h2) * 0.4);
      snow = sm(0.9, 0.96, lat + h * 0.05);
      col = mix(col, vec3f(0.92), snow);
    } else if (seaOn) {
      if (h < world.sea) {
        let dep = clamp((world.sea - h) * 4.0, 0.0, 1.0);
        col = mix(B, A, dep);
        spec = 1.0;
        seaDepth = world.terrA * (world.sea - h);
        // shallows: clear turquoise, fading into the deep's colour by ~25 m, the sandy bottom showing
        // through in the last few metres
        let shallow = 1.0 - smoothstep(0.0, 25.0, seaDepth);
        col = mix(col, mix(vec3f(0.1, 0.42, 0.45), vec3f(0.5, 0.5, 0.4), 1.0 - smoothstep(0.5, 3.0, seaDepth)), shallow);
      } else {
        let e = h - world.sea;
        if (world.city > 0.5) { pop = cityPop(p, e, lat); }
        col = mix(C, D, sm(0.12, 0.55, e + h2 * 0.12));
        col = mix(col, C * 0.7 + vec3f(0.18, 0.15, 0.08), sm(0.2, 0.6, h2) * 0.3);
        // climate (docs/terrain.md): the land's cover by how warm and how wet it is, blended over the
        // world's palette (two thirds), so its own character stays
        let cl = landClimate(p, e, lat, seed);
        col = mix(col, cl, 0.65 * (1.0 - sm(0.35, 0.6, e)));
        snow = max(sm(0.62, 0.75, e), sm(0.05, -0.12, landTemp(e, lat)) * 0.85);
        col = mix(col, vec3f(0.9), snow);
        // lakes: in low, flat basins where the land's wettest, still water (as the sea's, a few metres
        // deep; the geometry's the land's there, so only small and flat)
        // (their outline from the noise alone, the height and wetness only nudging its threshold:
        // gated by the height directly, on a wide flat plain a lake's edge followed tiny differences
        // in it, and neighbouring terrain chunks, which have them, cut it along their straight
        // edges, SPACE-78)
        let lakeN = snoise(p * 60.0 + vec3f(seed * 2.7, 4.0, 9.0)) + 0.2 * snoise(p * 220.0 + 3.0);
        let lakeK = 0.3 * sm(0.06, 0.0, e) + 0.15 * sm(0.4, 0.7, landMoist(p, e, lat, seed));
        let lake = sm(0.38, 0.41, lakeN + lakeK - 0.45 - 0.5 * sm(0.05, 0.15, e));
        if (lake > 0.5) {
          // (the sea's colour a few tens of metres down: darker than the sea, they stood out from
          // orbit as dark blue patches on the land)
          col = mix(B, A, 0.5);
          spec = 1.0;
          seaDepth = 14.0;
          col = mix(col, vec3f(0.1, 0.42, 0.45), 1.0 - smoothstep(0.0, 25.0, seaDepth));
        }
      }
      let ice = sm(0.8, 0.86, lat + h * 0.1);
      snow = max(snow, ice);
      col = mix(col, vec3f(0.93, 0.95, 1.0), ice);
      spec *= 1.0 - ice;
    } else if (ty == 4) {
      let cr = 1.0 - abs(snoise(sp * 3.0 + h));
      let cr2 = 1.0 - abs(snoise(sp * 9.0 + h2 * 2.0));
      col = mix(A, B, sm(-0.3, 0.6, h));
      let glow = pow(max(cr, 0.0), 14.0) + pow(max(cr2, 0.0), 18.0) * 0.6;
      emit = C * glow * 1.4;
      col *= 1.0 - glow * 0.6;
    } else {
      let cr = 1.0 - abs(snoise(sp * 4.0 + h * 2.0));
      col = mix(A, B, sm(-0.5, 0.5, h));
      col = mix(col, C, pow(max(cr, 0.0), 22.0) * 0.75);
    }
  }
  col *= mix(det, 1.0, spec);
  // the ground up close: patches, rock on steep ground, stones, grain and small bumps
  if (terr && spec <= 0.0 && ty < 6 && !dark) {
    let gd = groundDetail(col, N, normalize(in.wp - world.atC.xyz), in.wp, fw, ty == 2 || ty == 3);
    // (mostly not on snow: its stones and soil patches read as dark spots scattered over it)
    col = mix(gd.col, col, snow * 0.85);
    N = gd.N;
  }
  ndl = dot(N, L);
  var diff = clamp(ndl * 1.05 + 0.03, 0.0, 1.0) * in.t.z;
  let diff2 = select(0.0, clamp(dot(N, L2) * 1.05 + 0.03, 0.0, 1.0), two);
  // the cloud layer's shadow: the cover where the sun's ray from here crosses the deck
  if (world.cloudH > 0.0 && !dark) {
    let up = dot(p, world.lightL.xyz);
    if (up > 0.0) {
      let s = max(world.cloudH - elev, 0.0) / max(up, 0.08);
      let cloud = cloudCover(cloudMap(normalize(p * (world.radius + elev) + world.lightL.xyz * s)));
      // (where the volumetric clouds are on, their overcast dims the scene under them already, vclouds.wgsl
      // skyDim: both left ~5 % of daylight on the ground, near black under cover)
      diff *= 1.0 - 0.75 * cloud * (1.0 - world.deckHide);
    }
  }
  // sunlight through the air, from the surface point relative to the centre (precise)
  // the far sphere: from the surface point relative to the centre (object space, precise)
  let C1 = transpose(toLocal3()) * (in.obj * world.radius);
  var sunC = in.sun;
  if (!terr) { sunC = atSunlightC(C1, L); }
  // eclipses and the ring's shadow (shadow.wgsl), from the surface point relative to the centre
  var Pc = C1;
  if (terr) { Pc = in.wp - world.atC.xyz; }
  // (the air just above is in the same shadow, so the haze over it dims with it: on a giant it's
  // most of what you see)
  let shade = eclipse(Pc) * ringShade(p * (world.radius + elev), world.lightL.xyz);
  sunC *= shade;
  var sunC2 = vec3f(0.0);
  if (two) {
    sunC2 = select(atSunlightC(C1, L2) * world.lightC2.rgb, in.sun2, terr) * ringShade(p * (world.radius + elev), world.lightL2.xyz) * eclipse2(Pc);
  }
  if (terr) { sunC *= shadowAt(in.wp, N); } // up close: sky stations', ships' and rocks' shadows on the ground
  if (terr && two) { sunC2 *= shadowAt2(in.wp, N); }
  // the sky's own light on the ground: by how high the sun is over the horizon here (the whole lit
  // sky, not the sun's angle to each slope), bluish, and holding up while it's low (at 0.07 by
  // N·L, the ground at dawn and dusk sat dark under a bright sky)
  let upP = normalize(Pc);
  let skyC = vec3f(0.78, 0.88, 1.0);
  let sky = select(vec3f(0.0), 0.15 * smoothstep(-0.15, 0.25, dot(upP, L)) * skyC, world.atOn > 0.5);
  let sky2 = select(vec3f(0.0), 0.15 * smoothstep(-0.15, 0.25, dot(upP, L2)) * skyC * world.lightC2.rgb, world.atOn > 0.5 && two);
  // Water (spec: its share here; docs/water.md): it shows the sky by Fresnel (dark looking down
  // into it, a mirror toward the horizon) over its own colour, and the suns' glitter, the sharper the
  // more of the waves are resolved here: glints on each wave up close, a broad glitter path far off.
  var waterF = 0.0;
  var waterAdd = vec3f(0.0);
  if (spec > 0.0) {
    let wv = waterWaves(in.wp, fw);
    // the slope, in the surface's plane, turned to world axes: the normal tips against it
    let gw = transpose(toLocal3()) * wv.xyz;
    // (on the sphere's true normal, not the mesh's: a coarse chunk's flat triangles showed in the
    // glint as straight-edged patches)
    let Ns = normalize(in.wp - world.atC.xyz);
    let Nw = normalize(Ns - (gw - Ns * dot(gw, Ns)));
    // (sharp only as far as the normal holds still across the pixel, Toksvig: a lobe narrower than
    // that aliased into moiré)
    let dn = fwidth(Nw);
    // the mirror's normal: the waves' only as far as they're resolved and hold still across the pixel;
    // far off, where many are under a pixel, they average out to the flat sea's (each pixel taking
    // one wave's tilt, the far sea near the horizon mirrored bright sky and darker sky by turns, in
    // high-contrast streaks)
    let Nr = normalize(mix(Ns, Nw, clamp(wv.w, 0.0, 1.0) / (1.0 + 60.0 * dot(dn, dn))));
    let F = 0.02 + 0.98 * pow(1.0 - clamp(dot(Nr, V), 0.0, 1.0), 5.0);
    // (a wave's back facing away would mirror the sea itself: kept just above the horizon)
    let up = normalize(Pc);
    var Rv = reflect(-V, Nr);
    if (dot(Rv, up) < 0.01) { Rv = normalize(Rv + up * (0.01 - dot(Rv, up))); }
    let skyR = waterSky(Pc, Rv, L, two, L2, shade);
    let n0 = mix(40.0, 900.0, wv.w);
    let n = n0 / (1.0 + n0 * dot(dn, dn) * 0.5);
    var glint = vec3f(1.0, 0.97, 0.9) * waterGlint(Nw, N, V, L, n) * sunC;
    if (two) { glint += waterGlint(Nw, N, V, L2, n) * sunC2; }
    waterF = F * spec;
    waterAdd = (skyR * F + glint) * spec;
    // surf: at the water's edge (under ~2.5 m), a band of white foam, broken up and moving with the waves (it hides
    // the water's mirror where it lies)
    if (terr && seaDepth < 6.0) {
      let q = toLocal3() * in.wp + world.waveO.xyz;
      let t = world.waveO.w;
      let wind = normalize(vec3f(1.0, 0.0, 0.6));
      let fn1 = tnoise(q / 9.6 + wind * 0.3 * t) * 0.6 + tnoise(q / 2.4 - wind * 0.5 * t) * 0.4;
      let shore = 1.0 - smoothstep(0.2, 2.5, seaDepth + fn1 * 0.8);
      // breakers (docs/water.md): wave fronts along the depth contours (so parallel to the shore),
      // one every 0.8 m of depth, rolling in every 6 s; a crest whitens as it breaks, under ~4 m,
      // leaving foam behind it, its line broken up along the shore. (Spaced by the distance from the
      // shore, the depth over the bottom's slope by screen derivatives, the slope was constant per
      // terrain triangle and the water showed the triangles.)
      let ph = seaDepth / 0.8 + t / 6.0 + fn1 * 0.25;
      let fr = fract(ph);
      let brk = smoothstep(4.5, 0.6, seaDepth) * smoothstep(-0.3, 0.1, fn1 + 0.15);
      let crest = (smoothstep(0.72, 0.95, fr) * (1.0 - smoothstep(0.95, 1.0, fr)) + 0.35 * (1.0 - smoothstep(0.0, 0.4, fr))) * brk;
      let vis = smoothstep(0.5, 3.0, 9.6 / max(fw * world.radius, 1e-3));
      let foam = min(0.85 * shore * smoothstep(0.05, 0.45, fn1) + 0.8 * crest, 0.9) * vis;
      col = mix(col, vec3f(0.85, 0.88, 0.9), foam);
      waterF *= 1.0 - foam;
      waterAdd *= 1.0 - foam;
    }
  }
  // (the ship's lamps, near: headlights and landing lights; world.wgsl lights up close only matter
  // for the ground under you)
  let lamps = select(vec3f(0.0), shipLights(N, in.wp, col), terr);
  // the night's own light, where the sun's gone: starlight and airglow, so the ground under an
  // overcast night isn't pitch black (it was 0.0002)
  let night2 = 1.0 - smoothstep(-0.2, 0.05, ndl20) * up2;
  let nightAmb = NIGHT_AMB * vec3f(0.55, 0.7, 1.0) * (1.0 - smoothstep(-0.2, 0.05, ndl0)) * night2;
  // Snow and rain (docs/terrain.md):
  //   - snow in shade is lit by the blue sky alone: bluer;
  //   - wet ground where it's raining (the cover overhead near its most, as gpu/effects.ts rain):
  //     darker, as soaked soil and rock are;
  //   - snow sparkles: tiny ice facets catching the sun, ~25 cm apart in the near-camera frame
  //     (world.waveO, precise), shifting as you move (the noise read moves with the view), only
  //     where they're over a pixel.
  let skyT = mix(vec3f(1.0), vec3f(0.72, 0.88, 1.25), snow);
  if (terr && ty < 6 && spec <= 0.0 && !dark && (ty == 2 || ty == 3)) {
    let covUp = cloudCover(cloudMap(p)) / select(0.85, 0.95, ty == 3);
    col *= 1.0 - 0.35 * smoothstep(0.8, 0.98, covUp) * (1.0 - snow);
  }
  col = col * (diff * sunC + diff2 * sunC2 + (sky + sky2) * skyT + 0.0002 + nightAmb + STRIKE_C * strikeLight(in.wp, N) + vec3f(0.9, 0.93, 1.0) * world.shine.w * clamp(dot(N, world.shine.xyz) * 1.05 + 0.03, 0.0, 1.0)) * (1.0 - waterF) + waterAdd + lamps;
  if (terr && snow > 0.01 && !dark) {
    let vis = 1.0 - smoothstep(0.06, 0.25, fw * world.radius);
    if (vis > 0.0) {
      let q = toLocal3() * in.wp + world.waveO.xyz;
      let nS = tnoise(q * 4.0 + toLocal3() * V * 5.0);
      let Hs = normalize(L + V);
      col += sunC * (smoothstep(0.29, 0.33, nS) * pow(max(dot(N, Hs), 0.0), 4.0) * snow * vis * 6.0);
    }
  }
  if (pop > 0.0) {
    let night = sm(0.1, -0.08, ndl0) * (1.0 - sm(-0.08, 0.1, ndl20) * up2);
    if (night > 0.0) {
      let lights = cityLights(p, pop, fw);
      col += mix(vec3f(1.0, 0.62, 0.3), vec3f(1.0, 0.88, 0.7), cityWhite) * lights * night * world.cityK;
    }
  }
  // valley fog at dawn (docs/terrain.md): on Earth-like and ocean worlds, low fog fills the ground
  // lying below its region's height (the cloud cube's coarse ground height, ~100 km across) by up to
  // ~150 m, in patches tens of km across, where the sun's rising (it's in the east, from just under
  // the horizon to ~17° up, burning off as it climbs). How much hides the ground is its thickness
  // along the line of sight (from above, its depth over the slant; from inside it, the distance).
  // Lit by the low sun and the sky. Before the haze, so it's hazed with the ground behind it.
  if ((ty == 2 || ty == 3) && world.cloudH > 0.0 && spec < 0.5 && !dark) {
    let upF = normalize(in.wp - world.atC.xyz);
    let e1 = dot(upF, L);
    let axisW = transpose(toLocal3()) * vec3f(0.0, 1.0, 0.0);
    let eastF = normalize(cross(axisW, upF) + vec3f(1e-6, 0.0, 0.0));
    let dawn = smoothstep(-0.1, 0.02, e1) * (1.0 - smoothstep(0.12, 0.3, e1)) * smoothstep(-0.05, 0.15, dot(L, eastF));
    if (dawn > 0.0) {
      let baseH = textureSampleLevel(cloudTex, cloudSamp, p, 0.0).g;
      let patchF = 0.5 + 0.5 * snoise(p * 90.0 + vec3f(seed * 3.3, 1.0, 7.0));
      // (and over low ground, under ~50–200 m: the coastal plains' morning fog; by the region's height
      // alone, ~it, the ground was rarely under it)
      let fogTop = max(baseH + 250.0 * patchF - 60.0, 50.0 + 150.0 * patchF);
      let depth = fogTop - elev;
      if (depth > 0.0) {
        let cosV = max(dot(V, upF), 0.04);
        let path = select(min(length(in.wp), 3000.0), depth / cosV, world.camAlt > fogTop);
        let amt = (1.0 - exp(-path / 150.0)) * dawn * smoothstep(0.0, 60.0, depth) * 0.95;
        // (its top is in the sun even where the valley floor's in the hills' shadow: the sunlight
        // through the air there, not the ground's, shadowed, which made the fog dark blue pools)
        let sunF = atSunlightC(Pc, L) * shade;
        let fogC = sunF * 0.8 * smoothstep(-0.05, 0.1, e1) + (sky + sky2) * 1.6 + vec3f(0.004);
        col = mix(col, fogC, amt);
      }
    }
  }
  if (world.atOn > 0.5 && terr) {
    col = col * in.hazeT + in.haze * shade;
  } else if (world.atOn > 0.5) {
    let vd = normalize(in.wp);
    let C1s = normalize(C1) * atR();
    let k = dot(C1s, vd);
    let sAir = k + sqrt(max(k * k - dot(C1s, C1s) + world.atTop * world.atTop, 0.0));
    var haze = atInscatterC(C1s - vd * min(sAir, length(in.wp)), C1s, L, 5) * shade;
    if (two) { haze += atInscatterC(C1s - vd * min(sAir, length(in.wp)), C1s, L2, 5) * world.lightC2.rgb; }
    col = col * atTrans + haze;
  } else {
    let rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += world.atmoCol.rgb * world.atmoCol.w * rim * clamp(ndl + 0.25, 0.0, 1.0) * 1.1;
  }
  col += emit;
  // (alpha 0.5 marks the sea for its reflections, tonemap.wgsl seaReflect; the exposure meter takes
  // it as half physical, which hardly matters)
  // auroras between you and the ground (atmo.wgsl aurora: the sky shell's far side is behind this
  // surface over the disc). In sky units, so not × exposure
  if (world.atOn > 0.5) {
    let auD = normalize(in.wp);
    let auC = world.atC.xyz;
    col += aurora(auD, vec2f(0.0, length(in.wp)), auC, dot(auD, auC), dot(auC, auC)) / max(frame.exposure, 1e-4);
  }
  return vec4f(col * frame.exposure, select(1.0, 0.5, spec > 0.5));
}
