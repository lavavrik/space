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

// The colour of a giant's face at `p` (a unit direction in its own frame), coarse (no turbulence,
// a few octaves): its clouds' colour, for the volumetric layer (vclouds.wgsl), one call a pixel.
fn giantColAt(p: vec3f) -> vec3f { return giantSurface(p, world.seed, world.wtype == 6, 3, true); }
