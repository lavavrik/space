// Atmospheric scattering, shared by the sky, the clouds and the ground (docs/atmosphere.md).
// Single scattering with exponential density (sim/atmosphere.ts): light from the sun, dimmed on its
// way down to each point (Chapman-function optical depth), scattered toward the camera and dimmed
// again on its way out. Positions are camera-relative world metres (the camera is at the origin).
uniform vec3 uAtC;      // the world's centre
uniform float uAtR;     // mean radius (m)
uniform float uAtH;     // scale height (m)
uniform float uAtTop;   // radius where the air ends (m)
uniform vec3 uAtBeta;   // scattering coefficient at the mean radius (1/m, per colour)
uniform float uAtSunI;  // sunlight's strength in display units
uniform float uAtOn;    // 1 if the world has air
#define AT_MAX_SAMPLES 10

float atDens(float r){ return exp(-max(r - uAtR, 0.0) / uAtH); } // no denser than at the mean radius

// Optical depth (∫ρ/ρ0 ds, m) from radius r to space toward a direction at cos-zenith mu
// (Schüler's approximation of the Chapman function); huge when the planet is in the way.
float atChapman(float r, float mu){
  if (mu < -sqrt(max(0.0, 1.0 - (uAtR * uAtR) / (r * r)))) return 1e9; // the sun's behind the planet
  float X = uAtR / uAtH, h = max(r - uAtR, 0.0) / uAtH;
  float c = sqrt(X + h);
  float ch;
  if (mu >= 0.0) ch = c / (c * mu + 1.0) * exp(-h);
  else {
    float x0 = sqrt(1.0 - mu * mu) * (X + h);
    ch = 2.0 * sqrt(x0) * exp(min(X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h);
  }
  return uAtH * ch;
}

// Where a ray from the camera along dir enters and leaves the air: t0, t1 (t1 < t0: it misses)
vec2 atSpan(vec3 dir){
  float b = dot(dir, uAtC), c = dot(uAtC, uAtC) - uAtTop * uAtTop;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(1.0, 0.0);
  float s = sqrt(disc);
  return vec2(max(b - s, 0.0), b + s);
}

// Light scattered toward the camera between C0 and C1 (relative to the world's centre), and the
// transmittance along it, from n samples (≤ AT_MAX_SAMPLES) packed toward whichever end is lower
// (denser). Centre-relative so a caller far away can pass precise points (see atInscatter).
vec3 atInscatterC(vec3 C0, vec3 C1, vec3 L, out vec3 trans, int n){
  vec3 d = C1 - C0;
  float len = length(d);
  trans = vec3(1.0);
  if (len < 1e-3 || uAtOn < 0.5) return vec3(0.0);
  vec3 dir = d / len;
  bool startLow = length(C0) < length(C1);
  vec3 sum = vec3(0.0);
  float od = 0.0, prev = 0.0;
  for (int i = 0; i < AT_MAX_SAMPLES; i++) {
    if (i >= n) break;
    float u = (float(i) + 1.0) / float(n);
    float w = startLow ? u * u : 1.0 - (1.0 - u) * (1.0 - u);
    float t = w * len, ds = t - prev;
    vec3 n = C0 + dir * (t - ds * 0.5);
    prev = t;
    float r = length(n);
    float rho = atDens(r);
    od += rho * ds;
    vec3 T = exp(-uAtBeta * (od + atChapman(r, dot(n / r, L))));
    sum += T * rho * ds;
  }
  trans = exp(-uAtBeta * od);
  float cosT = dot(dir, L);
  float phase = 0.0597 * (1.0 + cosT * cosT) + 0.04 * pow(max(cosT, 0.0), 12.0); // Rayleigh, plus a glow round the sun
  return uAtSunI * uAtBeta * sum * phase;
}

// The same between camera-relative points P0 and P1 (fine near the world; far away the subtraction
// of its ~10¹¹ m centre loses kilometres, so pass centre-relative points to atInscatterC instead)
vec3 atInscatter(vec3 P0, vec3 P1, vec3 L, out vec3 trans, int n){
  return atInscatterC(P0 - uAtC, P1 - uAtC, L, trans, n);
}

// Sunlight reaching a point n from the world's centre (0…1 per colour): reddens and dims through thick air
vec3 atSunlightC(vec3 n, vec3 L){
  if (uAtOn < 0.5) return vec3(1.0);
  float r = length(n);
  return exp(-uAtBeta * atChapman(r, dot(n / r, L)));
}
vec3 atSunlight(vec3 P, vec3 L){ return atSunlightC(P - uAtC, L); }
