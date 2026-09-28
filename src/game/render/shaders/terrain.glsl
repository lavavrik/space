// Terrain height, shared by the planet vertex and fragment shaders (sim/terrain.ts is the CPU twin
// and has the why; docs/terrain.md). Needs snoise, tnoise and FBM_EXACT (noise.glsl, noise3d.glsl).
uniform vec3 uTOff[17];  // per-octave noise offsets (terrainOffsets), wrapped to keep precision
uniform float uTerrA;    // relief amplitude (m); 0 for none
uniform float uRadius;   // the world's mean radius (m)
uniform float uCraters;  // 1 on moons: impact craters (terrainH)
#define T_OCT_MAX 17
#define TERR_GAIN 0.55   // continents: each octave's weight against the one before
#define MTN_FROM 3       // mountains: ridged octaves from here
#define MTN_GAIN 0.55
#define MTN_K 1.3        // mountain height against the continents
#define MTN_MEAN 0.3     // their average, subtracted so ranges rise from the land around them
#define FINE_FROM 8      // from this octave (a few km on an Earth) both roughen: gain FINE_GAIN,
#define FINE_GAIN 0.68   // so hills, rocks and gullies keep coming as you get closer
#define CRATER_FROM 3    // craters on every other octave from here to CRATER_TO: ~50 km to ~20 m
#define CRATER_TO 13     //   across on a Moon-sized world
#define CRATER_P 0.5     // chance a lattice cell holds a crater
float tDet;              // albedo detail from octaves 6+, ~unit contrast at every scale (fragment only)
float tMask;             // the mountain-range mask terrH found (octave 2), for terrHFrom

// Integer hashing that's exact in float32 and in double (sim/terrain.ts), so both sides put the
// same craters in the same places: every value stays an integer below 2^24.
float mod289i(float x){ return x - floor((x + 0.5) * (1.0 / 289.0)) * 289.0; }
float perm289(float x){ return mod289i((x * 34.0 + 1.0) * x); }

// Crater relief (h units) at lattice point q (the octave's noise coordinates, k cells per unit
// direction). Each cell may hold one crater: a random centre, radius 0.12–0.35 cells, a bowl with a
// flat floor and a raised rim. Depth is 0.2 of the diameter for small craters, shallower (∝ √size)
// past 8 km across, like real ones. The rim reaches 1.4 radii, under half a cell, so only the 2×2×2
// cells nearest q can reach it.
float craters(vec3 q, float k){
  vec3 base = floor(q - 0.5);
  float acc = 0.0;
  for (int n = 0; n < 8; n++) {
    vec3 c = base + vec3(float(n & 1), float((n >> 1) & 1), float(n >> 2));
    float h = perm289(perm289(perm289(mod289i(c.z) + 7.0) + mod289i(c.y)) + mod289i(c.x));
    if (perm289(h + 5.0) / 289.0 > CRATER_P) continue;
    vec3 cen = c + vec3(perm289(h + 1.0), perm289(h + 2.0), perm289(h + 3.0)) / 289.0;
    float r = 0.12 + 0.23 * perm289(h + 4.0) / 289.0;
    float x = length(q - cen) / r;
    if (x > 1.4) continue;
    float rho = r * uRadius / k; // radius (m)
    float depth = rho * 0.4 * min(1.0, sqrt(4000.0 / rho)); // m
    float prof = (x < 1.0 ? max(x * x - 1.0, -0.85) : 0.0) + 0.3 * exp(-((x - 1.0) / 0.22) * ((x - 1.0) / 0.22));
    acc += prof * depth / uTerrA;
    tDet += (x < 1.0 ? -0.6 : 0.0) + 2.0 * exp(-((x - 1.0) / 0.15) * ((x - 1.0) / 0.15)); // dark floors, bright rims
  }
  return acc;
}

// h at unit direction d with `oct` octaves; `coarse` gets h with only the first `split` of them.
// Continents: fBm. Mountains: ridged noise (sharp crests, 1 − |n| squared, each octave weighted by
// the one before so detail gathers on the ridges) inside ranges marked by octave 2. Craters (moons).
float terrH(vec3 d, int oct, int split, out float coarse){
  float a = 0.5, s = 0.0, k = 1.6;
  float am = 0.5, r = 0.0, w = 1.0, mask = 0.0, cr = 0.0;
  coarse = 0.0;
  tDet = 0.0;
  for (int i = 0; i < T_OCT_MAX; i++) {
    if (i >= oct) break;
    if (i == split) coarse = s + mask * (r - MTN_MEAN) * MTN_K + cr;
    vec3 q = d * k + uTOff[i];
    float n = i < FBM_EXACT ? snoise(q) : tnoise(q);
    s += a * n;
    if (i >= 6) tDet = tDet * 0.8 + n;
    if (i == 2) mask = smoothstep(-0.05, 0.45, n);
    if (i >= MTN_FROM) {
      float rn = 1.0 - abs(n);
      rn *= rn;
      r += am * rn * w;
      w = clamp(rn * 1.4, 0.25, 1.0);
      am *= i >= FINE_FROM ? FINE_GAIN : MTN_GAIN;
    }
    if (uCraters > 0.5 && i >= CRATER_FROM && i <= CRATER_TO && (i & 1) == 1) cr += craters(q, k);
    k *= 2.03;
    a *= i >= FINE_FROM ? FINE_GAIN : TERR_GAIN;
  }
  float h = s + mask * (r - MTN_MEAN) * MTN_K + cr;
  if (split >= oct) coarse = h;
  tMask = mask;
  return h;
}

// Octave weights and lattice scale, as terrH's loop builds them up
float octA(int i){ return 0.5 * pow(TERR_GAIN, float(min(i, FINE_FROM))) * pow(FINE_GAIN, float(max(i - FINE_FROM, 0))); }
float octAm(int i){ return 0.5 * pow(MTN_GAIN, float(min(i, FINE_FROM) - MTN_FROM)) * pow(FINE_GAIN, float(max(i - FINE_FROM, 0))); }

// terrH's octaves `from`…`oct` only, added to hc (terrH with `from` octaves, baked per vertex) with
// the range mask found there: the fragment shader's share, a few octaves finer than the geometry,
// instead of all 17 per pixel. (The ridge weight carried between octaves restarts at 0.6 here; only
// the finest ridges differ.)
float terrHFrom(vec3 d, int from, int oct, float hc, float mask){
  float s = 0.0, r = 0.0, w = 0.6, cr = 0.0, k = 1.6 * pow(2.03, float(from));
  if (from <= MTN_FROM) w = 1.0;
  tDet = 0.0;
  for (int i = 0; i < T_OCT_MAX; i++) {
    if (i < from) continue;
    if (i >= oct) break;
    vec3 q = d * k + uTOff[i];
    float n = i < FBM_EXACT ? snoise(q) : tnoise(q);
    s += octA(i) * n;
    if (i >= 6) tDet = tDet * 0.8 + n;
    if (i == 2) mask = smoothstep(-0.05, 0.45, n);
    if (i >= MTN_FROM) {
      float rn = 1.0 - abs(n);
      rn *= rn;
      r += octAm(i) * rn * w;
      w = clamp(rn * 1.4, 0.25, 1.0);
    }
    if (uCraters > 0.5 && i >= CRATER_FROM && i <= CRATER_TO && (i & 1) == 1) cr += craters(q, k);
    k *= 2.03;
  }
  // hc has the ranges' mean subtracted once the mask is known (from octave 3); before that, here
  return hc + s + mask * (r - (from <= 2 ? MTN_MEAN : 0.0)) * MTN_K + cr;
}
// elevation (m) above the mean radius for h: seas flatten everything below sea level
float terrElev(float h, float sea, bool seaOn){ return uTerrA * (seaOn ? max(h - sea, 0.0) : h); }
