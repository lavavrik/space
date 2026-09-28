// Sky station (render/skyMesh.ts, sim/skyGeom.ts): an open deck hanging in its world's air, +z up in
// object space, the deck's top at z = 0. Painted from the object-space position: dark deck plating
// with the pads marked and ringed with lights, the control tower's lit cab, a red beacon, metal
// panels underneath and the glow of the lift fans. Lit by the sun through the air and by the sky,
// then hazed by the air between it and the camera, like the ground (atmo.glsl).
#include <logdepthbuf_pars_fragment>
#define PADS 12
uniform vec3 uLight;      // direction to the star
uniform vec3 uUp;         // the station's up (world axes)
uniform vec2 uPadPos[PADS];
uniform float uPadR;
uniform int uPad;         // the granted pad (−1: none)
uniform float uSeed;
uniform float uTime;
uniform float uExp, uSkyK, uHeadK, uFloodK, uWinK;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_atmo
#pragma farlight_headlight

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }

void main(){
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vWN), V = normalize(-vWP), L = normalize(uLight);
  if (dot(N, V) < 0.0) N = -N; // double-sided
  float nUp = dot(N, uUp);
  float r = length(vObj.xy);
  float ang = atan(vObj.y, vObj.x);
  vec3 sig = vec3(0.0); // display-referred signal lights
  vec3 emit = vec3(0.0);
  vec3 base;
  float gloss = 0.3;

  bool deckTop = abs(vObj.z) < 1e-4 && nUp > 0.5;
  if (deckTop) {
    // deck plating: 20 m plates, a little mottled, with seams
    vec2 cell = floor(vObj.xy * 50.0), f = fract(vObj.xy * 50.0);
    float seam = smoothstep(0.0, 0.04, f.x) * smoothstep(0.0, 0.04, f.y) * smoothstep(1.0, 0.96, f.x) * smoothstep(1.0, 0.96, f.y);
    base = vec3(0.16, 0.165, 0.17) * (0.85 + 0.3 * hash(cell)) * mix(0.6, 1.0, seam);
    gloss = 0.15;
    // a painted walkway ring between the inner and outer pads, and hazard stripes round the rim
    base = mix(base, vec3(0.5, 0.45, 0.2), smoothstep(0.004, 0.0, abs(r - 0.275) - 0.003) * 0.6);
    float stripe = step(0.5, fract(ang * 40.0 / 6.2832 + r * 0.0));
    base = mix(base, mix(vec3(0.05), vec3(0.75, 0.6, 0.1), stripe), smoothstep(0.478, 0.482, r) * 0.8);
    for (int i = 0; i < PADS; i++) {
      vec2 d = vObj.xy - uPadPos[i];
      float dl = length(d);
      if (dl > uPadR * 1.25) continue;
      bool mine = i == uPad;
      // the pad: a lighter disc with a white ring and a cross
      base = mix(base, vec3(0.3, 0.31, 0.32), smoothstep(uPadR, uPadR * 0.97, dl));
      float ring = smoothstep(0.0015, 0.0, abs(dl - uPadR * 0.92));
      float cross = step(dl, uPadR * 0.6) * max(smoothstep(0.0025, 0.0, abs(d.x)), smoothstep(0.0025, 0.0, abs(d.y)));
      base = mix(base, vec3(0.85), max(ring, cross * 0.8));
      // lamps round its edge: a steady warm ring, or chasing green ones on your pad
      float a = atan(d.y, d.x) / 6.2832;
      float lamp = smoothstep(0.25, 0.0, abs(fract(a * 16.0) - 0.5)) * smoothstep(0.003, 0.0, abs(dl - uPadR));
      if (mine) sig += vec3(0.2, 1.0, 0.45) * lamp * (0.4 + 1.6 * pow(fract(a * 2.0 - uTime * 0.6), 4.0)) * 2.0;
      else sig += vec3(1.0, 0.8, 0.5) * lamp * 0.5;
    }
  } else if (vObj.z > 0.1399 && r < 0.0049) {
    // the beacon mast's tip: a slow red strobe
    base = vec3(0.3);
    if (vObj.z > 0.195) sig += vec3(1.0, 0.1, 0.05) * step(0.85, fract(uTime * 0.5)) * 6.0;
  } else if (vObj.z > 0.1 && vObj.z < 0.14 && r > 0.074) {
    // the control cab: a band of lit windows
    base = vec3(0.45, 0.47, 0.5);
    float win = smoothstep(0.108, 0.112, vObj.z) * smoothstep(0.132, 0.128, vObj.z) * step(0.12, fract(ang * 24.0 / 6.2832));
    base *= 1.0 - win * 0.9;
    emit += vec3(1.0, 0.85, 0.6) * win * uWinK * 1.5;
    gloss = 0.5;
  } else {
    // metal panels (tower, rim, underside, keel, pods)
    vec2 uv = vec2(ang * 0.5 / 3.14159 * 60.0, vObj.z * 60.0 + r * 30.0);
    vec2 cell = floor(uv), f = fract(uv);
    float seam = smoothstep(0.0, 0.05, f.x) * smoothstep(0.0, 0.05, f.y) * smoothstep(1.0, 0.95, f.x) * smoothstep(1.0, 0.95, f.y);
    base = mix(vec3(0.42, 0.43, 0.45), vec3(0.55, 0.54, 0.5), hash(cell)) * mix(0.55, 1.0, seam);
    gloss = 0.6;
    // lit portholes round the keel
    if (vObj.z < -0.04 && vObj.z > -0.2 && nUp < -0.1) {
      vec2 wc = floor(vec2(ang * 80.0 / 6.2832, vObj.z * 90.0));
      float w = step(0.8, hash(wc + 3.1)) * smoothstep(0.35, 0.15, length(fract(vec2(ang * 80.0 / 6.2832, vObj.z * 90.0)) - 0.5));
      emit += vec3(1.0, 0.85, 0.6) * w * uWinK;
    }
    // the rim's lights: white, with red at the pods' bearings, blinking
    if (abs(r - 0.5) < 0.001 && vObj.z > -0.02 && vObj.z < -0.01) {
      float l = smoothstep(0.3, 0.0, abs(fract(ang * 48.0 / 6.2832) - 0.5));
      sig += vec3(1.0, 0.95, 0.85) * l * step(0.5, fract(uTime * 0.8 + ang)) * 1.5;
    }
  }
  // the lift fans' exhaust glow under the pods
  if (abs(vObj.z + 0.12) < 1e-4 && nUp < -0.5) {
    float fan = 0.5 + 0.5 * sin(atan(vObj.y - sign(vObj.y) * 0.318, vObj.x - sign(vObj.x) * 0.318) * 7.0 + uTime * 20.0);
    base = vec3(0.1);
    sig += vec3(0.4, 0.7, 1.0) * (0.5 + 0.3 * fan);
  }

  // sunlight through the air, skylight by day, a little floodlight on the deck at night
  vec3 sunC = atSunlight(vWP, L);
  float ndl = max(dot(N, L), 0.0);
  float day = smoothstep(-0.12, 0.35, dot(uUp, L));
  float sky = uAtOn > 0.5 ? 0.07 * day * (0.6 + 0.4 * nUp) : 0.0;
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 60.0) * gloss;
  vec3 col = base * (ndl * sunC + sky + 0.0002) + sunC * spec * ndl;
  if (deckTop) col += base * vec3(1.0, 0.9, 0.75) * uFloodK * 0.6;
  col += headlight(N, vWP, base, uHeadK);
  col += emit;
  // the air between here and the camera
  if (uAtOn > 0.5) {
    vec3 trans;
    vec3 haze = atInscatter(vec3(0.0), vWP, L, trans, 5);
    col = col * trans + haze;
    sig *= trans;
  }
  col *= uExp;
  vec3 W = vec3(0.2126, 0.7152, 0.0722);
  gl_FragColor = vec4(col + sig, dot(col, W) / (dot(col + sig, W) + 1e-9));
}
