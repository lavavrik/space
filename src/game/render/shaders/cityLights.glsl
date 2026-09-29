// City lights on the night side of populated worlds (docs/terrain.md, "City lights").
//
// Where people live (cityPop): land, not the high mountains or the ice caps, most of all along the
// coasts, in a few broad settled regions (low-frequency noise) with wilderness between.
//
// What the lights look like (cityLights), from far to near, each part fading in as its detail grows
// past a few pixels (and left out while smaller: that's the filtering):
//   - urban areas: where the density plus fractal noise (fBm from ~250 km features down) is high,
//     a glow with ragged fractal edges — from orbit a continent's coasts are strung with cities;
//   - cities: over that, four levels of soft blobs (cells ~500 km down to ~8 km) — bright cities
//     with towns round them, fainter between;
//   - roads: inside them, ridged noise (1 − |noise|)⁵ at three scales (~25 km down to ~3 km), the
//     bright web of main roads through a city;
//   - lights: four levels of scattered bright specks (cells ~8 km down to ~125 m), how a lit area
//     breaks up into lamps when you look closer;
//   - streets: close in, a grid of lit streets ~200 m apart, turned per district, lamps along them;
//   - the countryside: sparse villages and farms outside the towns, single lights.
// Each factor averages 1 over its own scale (constants from Monte Carlo, noted), so the brightness
// holds as detail resolves. Everything was tuned offline against a numpy replica first.
uniform float uCity;   // 1: this world is populated
uniform float uCityK;  // the lights' brightness (render/exposure.ts CITY_K)

uvec3 cityPcg(uvec3 v){
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
// three uniform randoms for an integer cell (offset positive: cell indices reach ±2·10⁵)
vec3 cityHash(vec3 c, float salt){
  uvec3 u = uvec3(ivec3(c) + ivec3(1 << 20)) + uvec3(uint(salt), uint(uSeed * 1000.0), 0u);
  return vec3(cityPcg(u)) * (1.0 / 4294967295.0);
}

// Population density 0…1 at unit direction p (the world's frame), elevation e above the sea level
// (terrain h units), latitude |p.y|.
float cityPop(vec3 p, float e, float lat){
  if (e <= 0.002) return 0.0;
  float land = smoothstep(0.002, 0.01, e) * smoothstep(0.42, 0.18, e); // not the high ranges
  float coast = 1.0 + 1.6 * smoothstep(0.08, 0.0, e);                    // crowded along the coasts
  float temperate = smoothstep(0.82, 0.55, lat);                          // not the ice caps
  float region = smoothstep(-0.25, 0.45, snoise(p * 2.3 + vec3(uSeed * 3.1, 11.0, uSeed)));
  float rural = 0.55 + 0.45 * smoothstep(-0.3, 0.6, snoise(p * 9.0 + vec3(5.0, uSeed, 2.0)));
  return clamp(land * coast * temperate * region * rural, 0.0, 1.0);
}

// Spots: 3 × 3 cells round q (so they don't line up in a grid), each with a spot (chance P) of
// radius r0…r0·rk of a cell (log-uniform), brightness 0.3–1.7, profile exp(−k d²) out to d = dmax.
float citySpots(vec2 q, float salt, float P, float r0, float rk, float k, float dmax){
  vec2 c0 = floor(q);
  float sum = 0.0;
  for (int j = 0; j < 9; j++) {
    vec2 c = c0 + vec2(float(j % 3 - 1), float(j / 3 - 1));
    vec3 h = cityHash(vec3(c, salt), 0.0);
    if (h.x > P) continue;
    vec3 h2 = cityHash(vec3(c, salt), 31.0);
    float d = length(q - c - h2.xy) / (r0 * pow(rk, h.y));
    if (d < dmax) sum += (0.3 + 1.4 * h.z) * exp(-k * d * d) * smoothstep(dmax, 0.7 * dmax, d);
  }
  return sum;
}

// how resolved a feature of frequency f (cycles per unit) is: 0 at ≤ 1 px a cycle, 1 at ≥ 4 px
float cityRes(float f, float fw){ return clamp((1.0 / (f * fw) - 1.0) / 3.0, 0.0, 1.0); }

// Light (before uCityK) at p, for density pop; fw is the pixel's footprint on the unit sphere.
// white: how much of it is a big city's white-hot core.
float cityLights(vec3 p, float pop, float fw, out float white){
  white = 0.0;
  if (pop <= 0.0) return 0.0;
  // urban areas: fBm, octaves fading out below ~2 px
  vec3 sp = p + vec3(uSeed * 0.37, 3.1, uSeed * 0.21);
  float n = 0.0, amp = 0.5, f = 25.0;
  for (int i = 0; i < 10; i++) {
    float k = clamp(1.5 - 2.0 * f * fw, 0.0, 1.0);
    if (k <= 0.0) break;
    n += amp * k * snoise(sp * f + float(i) * 1.7);
    amp *= 0.6;
    f *= 2.0;
  }
  float I = smoothstep(0.4, 1.0, pop * 0.9 + 0.5 * n);
  // (plus a little everywhere people live: the towns inland, which the city blobs below gather up)
  float L = 0.7 * I + 0.12 * pop;
  // cities, lights and streets on the faces of a cube round the world (2D cells)
  vec3 a = abs(p);
  float face; vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { face = p.x > 0.0 ? 0.0 : 1.0; uv = p.yz / a.x; }
  else if (a.y >= a.z) { face = p.y > 0.0 ? 2.0 : 3.0; uv = p.xz / a.y; }
  else { face = p.z > 0.0 ? 4.0 : 5.0; uv = p.xy / a.z; }
  // cities: f = 0.15 + 0.85 · spots · C / P averages 1 (C = 4.47 for radius 0.2–0.7, exp(−2.5d²)
  // to 1.6); f^0.75 / (0.63 + 0.29 P) too, roughly (Monte Carlo)
  float s = 30.0;
  float Pc = mix(0.2, 0.6, pop);
  for (int i = 0; i < 4; i++) {
    float res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) break;
    float g = 0.15 + 0.85 * citySpots(uv * s * 0.5, face * 16.0 + float(i), Pc, 0.2, 3.5, 2.5, 1.6) * 4.47 / Pc;
    // (the coarsest level softened, f^0.75: whole regions shouldn't go dark)
    L *= mix(1.0, i == 0 ? pow(g, 0.75) / (0.63 + 0.29 * Pc) : g, res);
    s *= 4.0;
  }
  // roads: (1 − |snoise|)⁵ averages 0.293 (Monte Carlo on sim/terrain.ts snoise)
  f = 300.0;
  for (int i = 0; i < 3; i++) {
    float res = cityRes(2.0 * f, fw);
    if (res <= 0.0 || L <= 0.0) break;
    float t = max(0.0, 1.0 - abs(snoise(sp * f + float(i) * 31.7)));
    L *= mix(1.0, 0.4 + 0.6 * pow(t, 5.0) / 0.293, res);
    f *= 3.0;
  }
  // lights: f = 0.2 + A · specks averages 1 with A = 169.7; √-ish contrast f^0.75 / 0.576
  s = 30.0 * 64.0;
  for (int i = 0; i < 4; i++) {
    float res = cityRes(s, fw);
    if (res <= 0.0 || L <= 0.0) break;
    float g = 0.2 + 169.7 * citySpots(uv * s * 0.5, face * 16.0 + float(i) + 100.0, 0.7, 0.06, 2.667, 5.0, 1.0);
    L *= mix(1.0, pow(g, 0.75) / 0.576, res);
    s *= 4.0;
  }
  // streets: lines 0.08 wide either side of every 1/F (either axis: 15 % of the area), lamps along
  // them (≈ 0.55 on average), plus 0.08 between
  const float F = 40000.0;
  float res = cityRes(F, fw);
  if (res > 0.0 && L > 0.0) {
    float ang = cityHash(vec3(floor(uv * F / 12.0), face), 55.0).x * 1.5708;
    vec2 r = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * uv * F;
    vec2 t = abs(fract(r) - 0.5);
    float lines = max(1.0 - smoothstep(0.0, 0.08, t.x), 1.0 - smoothstep(0.0, 0.08, t.y));
    float lamps = 0.4 + 0.6 * (0.5 + 0.5 * cos(r.x * 18.85)) * (0.5 + 0.5 * cos(r.y * 18.85));
    L *= mix(1.0, (0.08 + lines * lamps) / 0.165, res);
  }
  white = smoothstep(1.5, 4.0, L);
  // the countryside: a village or farm in 8 % × density of cells, from ~8 km cells down; each shown
  // only while it's a few pixels (the next level down takes over)
  s = 30.0 * 64.0;
  for (int i = 0; i < 4; i++) {
    float res = cityRes(s, fw);
    if (res <= 0.0) break;
    vec2 q = uv * s * 0.5, c = floor(q);
    vec3 h = cityHash(vec3(c, face * 16.0 + float(i) + 700.0), 0.0);
    if (h.x < 0.08 * pop) {
      vec3 h2 = cityHash(vec3(c, face * 16.0 + float(i) + 700.0), 31.0);
      float d = length(q - c - 0.3 - 0.4 * h2.xy) / 0.05;
      L += res * (1.0 - cityRes(4.0 * s, fw)) * exp(-4.0 * d * d) * 0.9;
    }
    s *= 4.0;
  }
  // bright areas roll off (1.3 at most) instead of turning the tone map's flat white
  L *= 1.8;
  return 1.3 * L / (1.0 + L);
}
