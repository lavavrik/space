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
}

@vertex
fn vs(@location(0) position: vec3f, @location(1) normal: vec3f) -> Out {
  var o: Out;
  let wp = world.model * vec4f(position, 1.0);
  o.obj = position;
  o.wp = wp.xyz;
  o.wn = normalize((world.rotN * vec4f(normal, 0.0)).xyz);
  o.t = vec4f(0.0, 0.0, 1.0, 0.0);
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
  let wp = chunk.model * vec4f(pos, 1.0);
  o.obj = dir;
  o.wp = wp.xyz;
  o.wn = normalize((world.rotN * vec4f(A.xyz, 0.0)).xyz);
  o.offDir = position / world.radius;
  o.t = vec4f(skirt, chunk.vOct, B.x, B.y);
  o.mask = B.z;
  // the air between the camera and here varies smoothly: per vertex, not per pixel (at the ground:
  // skirt vertices hang far below it, where the air's density would blow up)
  let ground = (chunk.model * vec4f(pos + dir * skirt * chunk.skirtD, 1.0)).xyz;
  let L = normalize(world.light.xyz);
  let vd = normalize(ground);
  o.haze = atInscatter(vd * atSpan(vd).x, ground, L, 5);
  o.hazeT = atTrans;
  o.sun = atSunlight(ground, L);
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

@fragment
fn fs(in: Out) -> @location(0) vec4f {
  let terr = in.t.y > 0.5;
  // Skirts hang below every chunk's edge to hide the cracks between levels; a crack only ever shows
  // a skirt's top, so that keeps the full shader and the rest gets plain lit ground colour.
  if (terr && in.t.x > 0.5) {
    let d0 = clamp(dot(normalize(in.wn), normalize(world.light.xyz)) * 1.05 + 0.03, 0.0, 1.0);
    let c0 = mix(world.pa.rgb, world.pb.rgb, 0.5) * (d0 * in.t.z * in.sun + 0.0002);
    return vec4f((c0 * in.hazeT + in.haze) * frame.exposure, 1.0);
  }
  let p = normalize(in.obj);
  var N = normalize(in.wn);
  let V = normalize(-in.wp);
  let L = normalize(world.light.xyz);
  var ndl = dot(N, L);
  let ndl0 = ndl;
  let seed = world.seed;
  let sp = p * 1.6 + vec3f(seed * 1.7, seed * 2.3, seed * 0.9);
  let fw = max(length(fwidth(p)), 1e-9);
  var oct = min(world.oct, i32(clamp(log2(0.5 / (1.6 * fw)) / 1.02 + 1.0, 3.0, f32(T_OCT_MAX))));
  let ty = world.wtype;
  let dark = clamp(ndl * 1.05 + 0.03, 0.0, 1.0) < 0.002 && ty != 4;
  if (dark) { oct = min(oct, select(3, 8, world.city > 0.5)); }
  var col: vec3f;
  var emit = vec3f(0.0);
  var spec = 0.0;
  var det = 1.0;
  var elev = 0.0;
  var pop = 0.0;
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
    let h = terrHFrom(p, i32(in.t.y + 0.5), oct, hc, in.mask);
    tUseOff = false;
    let seaOn = ty == 2 || ty == 3;
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
      col = mix(col, vec3f(0.92), sm(0.9, 0.96, lat + h * 0.05));
    } else if (seaOn) {
      if (h < world.sea) {
        let dep = clamp((world.sea - h) * 4.0, 0.0, 1.0);
        col = mix(B, A, dep);
        spec = 1.0;
      } else {
        let e = h - world.sea;
        if (world.city > 0.5) { pop = cityPop(p, e, lat); }
        col = mix(C, D, sm(0.12, 0.55, e + h2 * 0.12));
        col = mix(col, C * 0.7 + vec3f(0.18, 0.15, 0.08), sm(0.2, 0.6, h2) * 0.3);
        col = mix(col, vec3f(0.9), sm(0.62, 0.75, e));
      }
      let ice = sm(0.8, 0.86, lat + h * 0.1);
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
  ndl = dot(N, L);
  var diff = clamp(ndl * 1.05 + 0.03, 0.0, 1.0) * in.t.z;
  // the cloud layer's shadow: the cover where the sun's ray from here crosses the deck
  if (world.cloudH > 0.0 && !dark) {
    let up = dot(p, world.lightL.xyz);
    if (up > 0.0) {
      let s = max(world.cloudH - elev, 0.0) / max(up, 0.08);
      let cloud = cloudCover(cloudMap(normalize(p * (world.radius + elev) + world.lightL.xyz * s)));
      diff *= 1.0 - 0.75 * cloud;
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
  if (terr) { sunC *= shadowAt(in.wp, N); } // up close: sky stations', ships' and rocks' shadows on the ground
  let sky = select(0.0, 0.07 * smoothstep(-0.12, 0.35, ndl0), world.atOn > 0.5);
  let R = reflect(-L, N);
  let s = pow(max(dot(R, V), 0.0), 60.0) * 0.7 * spec * diff;
  // (the ship's lamps, near: headlights and landing lights; world.wgsl lights up close only matter
  // for the ground under you)
  let lamps = select(vec3f(0.0), shipLights(N, in.wp, col), terr);
  // the night's own light, where the sun's gone: starlight and airglow, so the ground under an
  // overcast night isn't pitch black (it was 0.0002)
  let nightAmb = NIGHT_AMB * vec3f(0.55, 0.7, 1.0) * (1.0 - smoothstep(-0.2, 0.05, ndl0));
  col = col * (diff * sunC + sky + 0.0002 + nightAmb) + vec3f(1.0, 0.95, 0.85) * s * sunC + lamps;
  if (pop > 0.0) {
    let night = sm(0.1, -0.08, ndl0);
    if (night > 0.0) {
      let lights = cityLights(p, pop, fw);
      col += mix(vec3f(1.0, 0.62, 0.3), vec3f(1.0, 0.88, 0.7), cityWhite) * lights * night * world.cityK;
    }
  }
  if (world.atOn > 0.5 && terr) {
    col = col * in.hazeT + in.haze * shade;
  } else if (world.atOn > 0.5) {
    let vd = normalize(in.wp);
    let C1s = normalize(C1) * atR();
    let k = dot(C1s, vd);
    let sAir = k + sqrt(max(k * k - dot(C1s, C1s) + world.atTop * world.atTop, 0.0));
    let haze = atInscatterC(C1s - vd * min(sAir, length(in.wp)), C1s, L, 5);
    col = col * atTrans + haze * shade;
  } else {
    let rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    col += world.atmoCol.rgb * world.atmoCol.w * rim * clamp(ndl + 0.25, 0.0, 1.0) * 1.1;
  }
  col += emit;
  return vec4f(col * frame.exposure, 1.0);
}
