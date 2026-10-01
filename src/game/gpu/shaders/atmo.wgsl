// Atmospheric scattering (render/shaders/atmo.glsl; docs/atmosphere.md): single scattering in an
// exponential atmosphere, Chapman-function optical depth to the sun. Camera-relative world metres;
// the world's centre is world.atC. atInscatterC's transmittance goes to atTrans.
const AT_MAX_SAMPLES: i32 = 10;
var<private> atTrans: vec3f;

fn atR() -> f32 { return world.atC.w; }
fn atH() -> f32 { return world.atBeta.w; }

fn atDens(r: f32) -> f32 { return exp(-max(r - atR(), 0.0) / atH()); }

// Extinction: the air's scattering plus ozone's absorption, which takes out green and orange
// (Chappuis band; Earth's at sea-level density (0.65, 1.88, 0.085) × 1e-6 /m beside Rayleigh's
// blue 33.1e-6, so scaled to the air's blue). It hardly shows by day; along twilight's long paths
// it keeps the sky blue overhead and the far side pink over the world's shadow, where reddened
// sunlight plus the scattered blue went green. (Taken with the air's own profile: the real layer
// peaks at ~25 km.)
fn atExt() -> vec3f {
  let beta = world.atBeta.xyz;
  return beta + beta.z * world.ozone * vec3f(0.0196, 0.0568, 0.0026);
}

fn atChapman(r: f32, mu: f32) -> f32 {
  let R = atR();
  let H = atH();
  if (mu < -sqrt(max(0.0, 1.0 - (R * R) / (r * r)))) { return 1e9; }
  let X = R / H;
  let h = max(r - R, 0.0) / H;
  let c = sqrt(X + h);
  var ch: f32;
  if (mu >= 0.0) {
    ch = c / (c * mu + 1.0) * exp(-h);
  } else {
    let x0 = sqrt(1.0 - mu * mu) * (X + h);
    ch = 2.0 * sqrt(x0) * exp(min(X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h);
  }
  return H * ch;
}

// where a ray from the camera along dir enters and leaves the air (y < x: it misses)
fn atSpan(dir: vec3f) -> vec2f {
  let C = world.atC.xyz;
  let b = dot(dir, C);
  let c = dot(C, C) - world.atTop * world.atTop;
  let disc = b * b - c;
  if (disc < 0.0) { return vec2f(1.0, 0.0); }
  let s = sqrt(disc);
  return vec2f(max(b - s, 0.0), b + s);
}

fn atInscatterC(C0: vec3f, C1: vec3f, L: vec3f, n: i32) -> vec3f {
  let d = C1 - C0;
  let len = length(d);
  atTrans = vec3f(1.0);
  if (len < 1e-3 || world.atOn < 0.5) { return vec3f(0.0); }
  let dir = d / len;
  let startLow = length(C0) < length(C1);
  let beta = world.atBeta.xyz;
  let ext = atExt();
  var sum = vec3f(0.0);
  var od = 0.0;
  var prev = 0.0;
  for (var i = 0; i < AT_MAX_SAMPLES; i++) {
    if (i >= n) { break; }
    let u = (f32(i) + 1.0) / f32(n);
    let w = select(1.0 - (1.0 - u) * (1.0 - u), u * u, startLow);
    let t = w * len;
    let ds = t - prev;
    let q = C0 + dir * (t - ds * 0.5);
    prev = t;
    let r = length(q);
    let rho = atDens(r);
    od += rho * ds;
    let T = exp(-ext * (od + atChapman(r, dot(q / r, L))));
    sum += T * rho * ds;
  }
  atTrans = exp(-ext * od);
  let cosT = dot(dir, L);
  let phase = 0.0597 * (1.0 + cosT * cosT);
  // plus haze (dust, droplets): grey, scattering strongly forward (Henyey-Greenstein, g 0.76), so
  // the sun has a bright aureole that a low sun turns orange (its light along the path is reddened
  // in `sum`). A tenth of the air's blue: Earth's Mie at the ground is ~0.6 of it, but in a layer a
  // seventh as thick. (A tinted 0.04 × cos¹² lobe before: the sunset sky had no glow round the sun.)
  let gM = 0.76;
  let dM = 1.0 + gM * gM - 2.0 * gM * cosT;
  let phaseM = (1.0 - gM * gM) / (dM * sqrt(dM)) / 12.566;
  let raw = world.atSunI * sum * (beta * phase + vec3f(0.1 * beta.z * phaseM));
  // (what's seen through the haze dims through a long path's reddened light: paled as the haze is,
  // or distant clouds by the horizon went yellow under a white haze, SPACE-73)
  // (paled less where the sunlight itself is reddened, at sunset: its colours are real there, and
  // paled, a low sun's sky was a washed-out yellow-white rather than orange)
  let rC0 = length(C0);
  let Ts = exp(-ext * atChapman(rC0, dot(C0 / rC0, L)));
  let pale = 0.6 * (1.0 - 0.85 * smoothstep(0.15, 0.7, 1.0 - Ts.b / max(Ts.r, 1e-4)));
  let l = dot(raw, vec3f(0.2126, 0.7152, 0.0722));
  if (l > ATR_KNEE) {
    let x = l - ATR_KNEE;
    atTrans = mix(atTrans, vec3f(dot(atTrans, vec3f(0.2126, 0.7152, 0.0722))), pale * x / (1.0 + x));
  }
  return atRolloffP(raw, pale);
}

// Long grazing paths low in the air (the horizon from near the ground) saturate every colour at ~3–5×
// white, which the tone map flattened into a wide white band: over ATR_KNEE the brightness is
// compressed and paled toward white as it is (as the eye sees a bright haze; kept, the long path's
// hue went yellow), so the horizon stays pale and bright but narrow. Applied to all inscatter
// (the sky, the ground's and the clouds' haze) so they still meet seamlessly at the horizon.
// (It levels off at ATR_KNEE + 1/ATR_K: at 0.7 + 0.67 the tone map, white from 0.8 up, made the
// near-horizon sky a flat white, worst filling the periscope's view, and a pair's second sun's haze
// on top of it went further; now ~0.95, still paled toward white.)
const ATR_KNEE = 0.5;
const ATR_K = 2.2;
fn atRolloff(c: vec3f) -> vec3f { return atRolloffP(c, 0.6); }
fn atRolloffP(c: vec3f, pale: f32) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (l <= ATR_KNEE) { return c; }
  let x = l - ATR_KNEE;
  let lo = ATR_KNEE + x / (1.0 + ATR_K * x);
  return mix(c * (lo / l), vec3f(lo), pale * x / (1.0 + x)); // (paled less, 0.35, distant clouds by the horizon went yellow)
}

fn atInscatter(P0: vec3f, P1: vec3f, L: vec3f, n: i32) -> vec3f {
  return atInscatterC(P0 - world.atC.xyz, P1 - world.atC.xyz, L, n);
}

fn atSunlightC(q: vec3f, L: vec3f) -> vec3f {
  if (world.atOn < 0.5) { return vec3f(1.0); }
  let r = length(q);
  return exp(-atExt() * atChapman(r, dot(q / r, L)));
}
fn atSunlight(P: vec3f, L: vec3f) -> vec3f { return atSunlightC(P - world.atC.xyz, L); }

// Twilight's light: once the sun is down, the sky's light is mostly sunlight scattered more than
// once from the still-lit air high up, which single scattering (above) leaves out: the sky went
// black at −2°, the blue hour never came. An approximation: a glow peaking with the sun just below
// the horizon, gone by ~12° below and by ~8° above (where single scattering has it), bluish, warmer
// toward the sun. `up`: the local vertical where it's seen or received; `dir`: the view direction
// (for the warmth toward the sun; the up vector for light received). Scaled by the air's blue,
// against Earth's.
fn atTwilight(up: vec3f, L: vec3f, dir: vec3f) -> vec3f {
  if (world.atOn < 0.5) { return vec3f(0.0); }
  let e = dot(up, L);
  let w = smoothstep(-0.21, -0.03, e) * (1.0 - smoothstep(0.03, 0.14, e));
  if (w <= 0.0) { return vec3f(0.0); }
  let Lh = normalize(L - up * e + vec3f(0.0, 1e-7, 0.0));
  let toward = max(dot(normalize(dir - up * dot(dir, up) + vec3f(1e-7, 0.0, 0.0)), Lh), 0.0);
  let col = mix(vec3f(0.3, 0.42, 0.85), vec3f(0.95, 0.55, 0.35), toward * toward);
  return col * 0.05 * w * (0.7 + 0.8 * toward * toward) * min(world.atBeta.z / 3.31e-5, 3.0);
}
