// City lights on the night side of populated worlds (render/shaders/cityLights.glsl has the design
// notes; sim/population.ts mirrors cityPop: keep them in step). cityWhite is cityLights' second result.
var<private> cityWhite: f32;

fn cityPcg(v0: vec3u) -> vec3u {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> vec3u(16u);
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

fn cityHash(c: vec3f, salt: f32) -> vec3f {
  let u = vec3u(vec3i(c) + vec3i(1 << 20u)) + vec3u(u32(salt), u32(world.seed * 1000.0), 0u);
  return vec3f(cityPcg(u)) * (1.0 / 4294967295.0);
}

fn cityPop(p: vec3f, e: f32, lat: f32) -> f32 {
  if (e <= 0.002) { return 0.0; }
  let s = world.seed;
  let land = sm(0.002, 0.01, e) * sm(0.42, 0.18, e);
  let coast = 1.0 + 1.6 * sm(0.08, 0.0, e);
  let temperate = sm(0.82, 0.55, lat);
  let region = sm(-0.25, 0.45, snoise(p * 2.3 + vec3f(s * 3.1, 11.0, s)));
  let rural = 0.55 + 0.45 * sm(-0.3, 0.6, snoise(p * 9.0 + vec3f(5.0, s, 2.0)));
  return clamp(land * coast * temperate * region * rural, 0.0, 1.0);
}

fn citySpots(q: vec2f, salt: f32, P: f32, r0: f32, rk: f32, k: f32, dmax: f32) -> f32 {
  let c0 = floor(q);
  var sum = 0.0;
  for (var j = 0; j < 9; j++) {
    let c = c0 + vec2f(f32(j % 3 - 1), f32(j / 3 - 1));
    let h = cityHash(vec3f(c, salt), 0.0);
    if (h.x > P) { continue; }
    let h2 = cityHash(vec3f(c, salt), 31.0);
    let d = length(q - c - h2.xy) / (r0 * pow(rk, h.y));
    if (d < dmax) { sum += (0.3 + 1.4 * h.z) * exp(-k * d * d) * sm(dmax, 0.7 * dmax, d); }
  }
  return sum;
}

fn cityRes(f: f32, fw: f32) -> f32 { return clamp((1.0 / (f * fw) - 1.0) / 3.0, 0.0, 1.0); }

fn cityLights(p: vec3f, pop: f32, fw: f32) -> f32 {
  cityWhite = 0.0;
  if (pop <= 0.0) { return 0.0; }
  let sp = p + vec3f(world.seed * 0.37, 3.1, world.seed * 0.21);
  var n = 0.0;
  var amp = 0.5;
  var f = 25.0;
  for (var i = 0; i < 10; i++) {
    let k = clamp(1.5 - 2.0 * f * fw, 0.0, 1.0);
    if (k <= 0.0) { break; }
    n += amp * k * snoise(sp * f + f32(i) * 1.7);
    amp *= 0.6;
    f *= 2.0;
  }
  let I = sm(0.4, 1.0, pop * 0.9 + 0.5 * n);
  var L = 0.7 * I + 0.12 * pop;
  let a = abs(p);
  var face: f32;
  var uv: vec2f;
  if (a.x >= a.y && a.x >= a.z) { face = select(1.0, 0.0, p.x > 0.0); uv = p.yz / a.x; }
  else if (a.y >= a.z) { face = select(3.0, 2.0, p.y > 0.0); uv = p.xz / a.y; }
  else { face = select(5.0, 4.0, p.z > 0.0); uv = p.xy / a.z; }
  var s = 30.0;
  let Pc = mix(0.2, 0.6, pop);
  for (var i = 0; i < 4; i++) {
    let res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let g = 0.15 + 0.85 * citySpots(uv * s * 0.5, face * 16.0 + f32(i), Pc, 0.2, 3.5, 2.5, 1.6) * 4.47 / Pc;
    L *= mix(1.0, select(g, pow(g, 0.75) / (0.63 + 0.29 * Pc), i == 0), res);
    s *= 4.0;
  }
  f = 300.0;
  for (var i = 0; i < 3; i++) {
    let res = cityRes(2.0 * f, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let t = max(0.0, 1.0 - abs(snoise(sp * f + f32(i) * 31.7)));
    L *= mix(1.0, 0.4 + 0.6 * pow(t, 5.0) / 0.293, res);
    f *= 3.0;
  }
  s = 30.0 * 64.0;
  for (var i = 0; i < 4; i++) {
    let res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) { break; }
    let g = 0.2 + 169.7 * citySpots(uv * s * 0.5, face * 16.0 + f32(i) + 100.0, 0.7, 0.06, 2.667, 5.0, 1.0);
    L *= mix(1.0, pow(g, 0.75) / 0.576, res);
    s *= 4.0;
  }
  let F = 40000.0;
  let res = cityRes(F, fw);
  if (res > 0.0 && L > 0.0) {
    let ang = cityHash(vec3f(floor(uv * F / 12.0), face), 55.0).x * 1.5708;
    let r = mat2x2f(cos(ang), sin(ang), -sin(ang), cos(ang)) * uv * F;
    let t = abs(fract(r) - 0.5);
    let lines = max(1.0 - smoothstep(0.0, 0.08, t.x), 1.0 - smoothstep(0.0, 0.08, t.y));
    let lamps = 0.4 + 0.6 * (0.5 + 0.5 * cos(r.x * 18.85)) * (0.5 + 0.5 * cos(r.y * 18.85));
    L *= mix(1.0, (0.08 + lines * lamps) / 0.165, res);
  }
  cityWhite = sm(1.5, 4.0, L);
  s = 30.0 * 64.0;
  for (var i = 0; i < 4; i++) {
    let res2 = cityRes(s, fw);
    if (res2 <= 0.0) { break; }
    let q = uv * s * 0.5;
    let c = floor(q);
    let h = cityHash(vec3f(c, face * 16.0 + f32(i) + 700.0), 0.0);
    if (h.x < 0.08 * pop) {
      let h2 = cityHash(vec3f(c, face * 16.0 + f32(i) + 700.0), 31.0);
      let d = length(q - c - 0.3 - 0.4 * h2.xy) / 0.05;
      L += res2 * (1.0 - cityRes(4.0 * s, fw)) * exp(-4.0 * d * d) * 0.9;
    }
    s *= 4.0;
  }
  L *= 1.8;
  return 1.3 * L / (1.0 + L);
}
