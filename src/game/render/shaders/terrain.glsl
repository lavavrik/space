// Terrain height, shared by the planet vertex and fragment shaders (sim/terrain.ts is the CPU twin
// and has the why; docs/terrain.md). Needs snoise, tnoise and FBM_EXACT (noise.glsl, noise3d.glsl).
uniform vec3 uTOff[17];  // per-octave noise offsets (terrainOffsets), wrapped to keep precision
uniform float uTerrA;    // relief amplitude (m); 0 for none
#define T_OCT_MAX 17
#define TERR_GAIN 0.55   // continents: each octave's weight against the one before
#define MTN_FROM 3       // mountains: ridged octaves from here
#define MTN_GAIN 0.55
#define MTN_K 1.3        // mountain height against the continents
#define MTN_MEAN 0.3     // their average, subtracted so ranges rise from the land around them
#define FINE_FROM 8      // from this octave (a few km on an Earth) both roughen: gain FINE_GAIN,
#define FINE_GAIN 0.68   // so hills, rocks and gullies keep coming as you get closer
float tDet;              // albedo detail from octaves 6+, ~unit contrast at every scale (fragment only)
// h at unit direction d with `oct` octaves; `coarse` gets h with only the first `split` of them.
// Continents: fBm. Mountains: ridged noise (sharp crests, 1 − |n| squared, each octave weighted by
// the one before so detail gathers on the ridges) inside ranges marked by octave 2.
float terrH(vec3 d, int oct, int split, out float coarse){
  float a = 0.5, s = 0.0, k = 1.6;
  float am = 0.5, r = 0.0, w = 1.0, mask = 0.0;
  coarse = 0.0;
  tDet = 0.0;
  for (int i = 0; i < T_OCT_MAX; i++) {
    if (i >= oct) break;
    if (i == split) coarse = s + mask * (r - MTN_MEAN) * MTN_K;
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
    k *= 2.03;
    a *= i >= FINE_FROM ? FINE_GAIN : TERR_GAIN;
  }
  float h = s + mask * (r - MTN_MEAN) * MTN_K;
  if (split >= oct) coarse = h;
  return h;
}
// elevation (m) above the mean radius for h: seas flatten everything below sea level
float terrElev(float h, float sea, bool seaOn){ return uTerrA * (seaOn ? max(h - sea, 0.0) : h); }
