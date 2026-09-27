// Orbital station: a unit cube (object space −0.5…0.5) of brushed, mirror-like metal panels.
// There's no environment map, so reflections sample a tiny procedural sky instead: black space,
// the Milky Way band, the star as a sharp highlight, and the parent world as a soft glow.
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;      // direction to the star
uniform vec3 uStarColor;
uniform float uLit;       // 0 in the parent's shadow, 1 in sunlight
uniform vec3 uPlanetDir;  // direction to the parent world
uniform vec3 uPlanetColor;
uniform float uPlanetSize; // cosine of the world's angular radius
uniform float uSeed;
uniform float uTime;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
#pragma farlight_headlight

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }

vec3 envColor(vec3 R, vec3 L){
  vec3 gn = normalize(vec3(0.05, 1.0, 0.12));
  float b = dot(R, gn);
  vec3 c = vec3(0.012, 0.014, 0.022) + vec3(0.07, 0.07, 0.09) * exp(-b * b / 0.02);
  float cp = dot(R, uPlanetDir);
  c += uPlanetColor * smoothstep(uPlanetSize - 0.02, uPlanetSize + 0.01, cp) * 0.35;
  float rl = max(dot(R, L), 0.0);
  c += uStarColor * uLit * (pow(rl, 900.0) * 30.0 + pow(rl, 60.0) * 0.6);
  return c;
}

void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vWN), V = normalize(-vWP), L = normalize(uLight);
  // face coordinates: the two object axes across the face we're on
  vec3 an = abs(vObj);
  vec2 uv = an.x > an.y && an.x > an.z ? vObj.yz : an.y > an.z ? vObj.xz : vObj.xy;
  uv += 0.5;
  bool front = an.z > an.x && an.z > an.y && vObj.z > 0.0;

  // hull plates: 10×10 panels with dark seams, each tinted and angled slightly differently
  vec2 cell = floor(uv * 10.0), f = fract(uv * 10.0);
  float seam = smoothstep(0.0, 0.035, f.x) * smoothstep(0.0, 0.035, f.y) * smoothstep(1.0, 0.965, f.x) * smoothstep(1.0, 0.965, f.y);
  float h = hash(cell);
  float brushed = snoise(vec3(uv.x * 4.0, uv.y * 260.0, uSeed)) * 0.5 + 0.5;
  vec3 base = mix(vec3(0.55, 0.57, 0.6), vec3(0.72, 0.7, 0.66), h) * (0.85 + 0.15 * brushed);
  // wobble each plate's normal a little so the reflections break up panel by panel
  vec3 Np = normalize(N + 0.035 * vec3(hash(cell + 1.3) - 0.5, hash(cell + 2.7) - 0.5, hash(cell + 4.1) - 0.5));

  vec3 R = reflect(-V, Np);
  float nv = clamp(dot(Np, V), 0.0, 1.0);
  vec3 F = base + (1.0 - base) * pow(1.0 - nv, 5.0); // Schlick Fresnel for a metal
  float ndl = max(dot(Np, L), 0.0);
  vec3 H = normalize(L + V);
  float gloss = pow(max(dot(Np, H), 0.0), 140.0) * 2.5; // broad sheen from the star
  float planetShine = max(dot(N, uPlanetDir), 0.0) * 0.12; // light bounced off the world below
  vec3 col = envColor(R, L) * F
    + base * uStarColor * ndl * uLit * 0.55
    + F * uStarColor * gloss * uLit * ndl
    + base * uPlanetColor * planetShine;
  // the station's own floodlights: pools of warm light washing each face from lamps at its edge
  // midpoints, so it's never pitch dark, even in its world's shadow
  vec2 e = uv - 0.5;
  float flood = exp(-dot(vec2(abs(e.x) - 0.5, e.y), vec2(abs(e.x) - 0.5, e.y)) / 0.06) + exp(-dot(vec2(e.x, abs(e.y) - 0.5), vec2(e.x, abs(e.y) - 0.5)) / 0.06);
  col += base * vec3(1.0, 0.9, 0.75) * flood * 0.28;
  // the ship's headlights
  col += headlight(Np, vWP, base);
  col *= mix(0.25, 1.0, seam);

  // the docking slot on the front face: a dark recess with a lit rim; approach lights run in toward
  // it along its long axis, green on one side (+x) and red on the other, like the tunnel inside
  if (front) {
    vec2 d = abs(uv - 0.5) - vec2(0.2, 0.06);
    float slot = step(max(d.x, d.y), 0.0);
    float rim = smoothstep(0.012, 0.0, abs(max(d.x, d.y)));
    col = mix(col, vec3(0.003), slot);
    col += vec3(0.25, 0.9, 0.55) * rim * 0.9;
    float ax = abs(uv.x - 0.5);
    if (ax > 0.21 && abs(uv.y - 0.5) < 0.012) {
      float cell = fract(ax * 30.0);
      float lamp = smoothstep(0.25, 0.0, abs(cell - 0.5)) * smoothstep(0.009, 0.0, abs(uv.y - 0.5));
      float run = 0.25 + 0.75 * pow(fract(ax * 3.0 + uTime * 0.8), 6.0); // pulses running inward
      col += (uv.x > 0.5 ? vec3(0.2, 1.0, 0.4) : vec3(1.0, 0.2, 0.15)) * lamp * run * 2.0;
    }
  }
  // navigation lights at the corners: blinking red / green by side, white strobes top and bottom
  vec3 ac = abs(vObj);
  if (ac.x > 0.47 && ac.y > 0.47 && ac.z > 0.47) {
    float blink = step(0.8, fract(uTime * 0.7 + (vObj.z > 0.0 ? 0.0 : 0.5)));
    vec3 nc = vObj.y > 0.0 ? vec3(1.0) : vObj.x > 0.0 ? vec3(0.2, 1.0, 0.4) : vec3(1.0, 0.2, 0.15);
    col += nc * blink * 3.0;
  }
  // scattered windows and running lights, so the station is visible on its night side too
  vec2 wc = floor(uv * 60.0);
  float win = step(0.99, hash(wc + 7.0)) * smoothstep(0.35, 0.1, length(fract(uv * 60.0) - 0.5));
  col += vec3(1.0, 0.85, 0.6) * win * 0.7;
  gl_FragColor = vec4(col, 1.0);
}
