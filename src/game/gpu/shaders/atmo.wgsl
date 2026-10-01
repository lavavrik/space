// Atmospheric scattering (render/shaders/atmo.glsl; docs/atmosphere.md): single scattering in an
// exponential atmosphere, Chapman-function optical depth to the sun. Camera-relative world metres;
// the world's centre is world.atC. atInscatterC's transmittance goes to atTrans.
const AT_MAX_SAMPLES: i32 = 10;
var<private> atTrans: vec3f;

fn atR() -> f32 { return world.atC.w; }
fn atH() -> f32 { return world.atBeta.w; }

fn atDens(r: f32) -> f32 { return exp(-max(r - atR(), 0.0) / atH()); }

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
    let T = exp(-beta * (od + atChapman(r, dot(q / r, L))));
    sum += T * rho * ds;
  }
  atTrans = exp(-beta * od);
  let cosT = dot(dir, L);
  let phase = 0.0597 * (1.0 + cosT * cosT) + 0.04 * pow(max(cosT, 0.0), 12.0);
  return atRolloff(world.atSunI * beta * sum * phase);
}

// Long grazing paths low in the air (the horizon from near the ground) saturate every colour at ~3–5×
// white, which the tone map flattened into a wide white band: over ATR_KNEE the brightness is
// compressed and paled toward white as it is (as the eye sees a bright haze; kept, the long path's
// hue went yellow), so the horizon stays pale and bright but narrow. Applied to all inscatter
// (the sky, the ground's and the clouds' haze) so they still meet seamlessly at the horizon.
// (It levels off at ATR_KNEE + 1/ATR_K: at 0.7 + 0.67 the tone map, white from 0.8 up, made the
// near-horizon sky a flat white, worst filling the periscope's view, and a pair's second sun's haze
// on top of it went further; now ~0.95, paled less, so it stays a bright pale blue-yellow.)
const ATR_KNEE = 0.5;
const ATR_K = 2.2;
fn atRolloff(c: vec3f) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  if (l <= ATR_KNEE) { return c; }
  let x = l - ATR_KNEE;
  let lo = ATR_KNEE + x / (1.0 + ATR_K * x);
  return mix(c * (lo / l), vec3f(lo), 0.35 * x / (1.0 + x));
}

fn atInscatter(P0: vec3f, P1: vec3f, L: vec3f, n: i32) -> vec3f {
  return atInscatterC(P0 - world.atC.xyz, P1 - world.atC.xyz, L, n);
}

fn atSunlightC(q: vec3f, L: vec3f) -> vec3f {
  if (world.atOn < 0.5) { return vec3f(1.0); }
  let r = length(q);
  return exp(-world.atBeta.xyz * atChapman(r, dot(q / r, L)));
}
fn atSunlight(P: vec3f, L: vec3f) -> vec3f { return atSunlightC(P - world.atC.xyz, L); }
