// Inside a station (unit coordinates, see sim/stationGeom.ts): the slot tunnel, the hangar
// cylinder and its end walls. No sunlight gets in; it's lit by rows of lamps along the hangar and
// by the pads' own lights. Pads are rings on the curved wall; the one granted to you glows amber
// and pulses (uPadOn), the rest are dim cyan. Slot tunnel: green lights on one side, red on the
// other, so you can tell which way is which as it turns.
#include <logdepthbuf_pars_fragment>
uniform vec3 uPad;       // the granted pad's centre (unit coordinates)
uniform float uPadOn;    // 1 if a pad is granted at this station
uniform float uTime;
uniform float uSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
// Lamp light is physical (the lamps ≙ 1.0 here, 500 lux), scaled to scene units by uIntK and
// then by the exposure; pad markers and the tunnel guide lights are display-referred signals,
// added after it (render/exposure.ts).
uniform float uHeadKi; // headlight: candela → brightness against the hangar lamps
uniform float uIntK;   // INT_K
uniform float uExp;    // exposure
#pragma farlight_headlight

const float R = 0.42;          // HANGAR_R
const float PAD_R = 0.04;      // PAD_R
const float ROW0 = 0.2, ROW1 = -0.04, ROW2 = -0.28; // PAD_ROWS
const float COLS = 6.0;        // PAD_COLS

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7)) + uSeed) * 43758.5453); }

// distance (unit coordinates, across the wall) to the nearest pad centre on the hangar wall
float padDist(vec3 p, out vec3 centre){
  float best = 1e3;
  float phi = atan(p.y, p.x);
  for (int row = 0; row < 3; row++) {
    float z = row == 0 ? ROW0 : row == 1 ? ROW1 : ROW2;
    float off = mod(float(row), 2.0) * 3.14159265 / COLS;
    float k = floor((phi - off) / (6.2831853 / COLS) + 0.5);
    float a = k * 6.2831853 / COLS + off;
    float da = atan(sin(phi - a), cos(phi - a));
    float d = length(vec2(da * R, p.z - z));
    if (d < best) { best = d; centre = vec3(R * cos(a), R * sin(a), z); }
  }
  return best;
}

void main(){
  #include <logdepthbuf_fragment>
  vec3 p = vObj;
  vec3 N = normalize(vWN);
  float r = length(p.xy);
  bool wall = abs(r - R) < 0.004 && p.z < 0.399;
  bool tunnel = p.z > 0.399;

  // base: dull grey plating with seams
  vec2 uv = wall ? vec2(atan(p.y, p.x) * R, p.z) : tunnel ? (abs(N.x) > 0.5 ? p.yz : p.xz) : p.xy;
  vec2 cell = floor(uv * 40.0), f = fract(uv * 40.0);
  float seam = smoothstep(0.0, 0.04, f.x) * smoothstep(0.0, 0.04, f.y) * smoothstep(1.0, 0.96, f.x) * smoothstep(1.0, 0.96, f.y);
  vec3 base = mix(vec3(0.16, 0.17, 0.18), vec3(0.22, 0.22, 0.21), hash(cell)) * mix(0.6, 1.0, seam);

  // lamps: bright strips along the hangar wall between pad columns, and around the end walls
  float light = 0.35;
  if (wall) {
    float phi = atan(p.y, p.x);
    float strip = abs(fract(phi / (6.2831853 / COLS)) - 0.5);
    light += 0.9 * smoothstep(0.03, 0.0, abs(strip - 0.5) - 0.0) ;
    light += 0.6 * smoothstep(0.015, 0.0, abs(fract(p.z * 6.0) - 0.5) - 0.47);
  } else if (!tunnel) {
    light += 0.8 * smoothstep(0.006, 0.0, abs(r - R * 0.96));
  }
  vec3 col = base * light + headlight(N, vWP, base, uHeadKi);
  // lamps glow themselves
  if (wall) {
    float phi = atan(p.y, p.x);
    float strip = fract(phi / (6.2831853 / COLS));
    col += vec3(1.0, 0.9, 0.75) * smoothstep(0.006, 0.0, min(strip, 1.0 - strip)) * 0.8;
  }
  col *= uIntK * uExp;
  vec3 sig = vec3(0.0); // display-referred signal lights

  // pads on the hangar wall
  if (wall) {
    vec3 c;
    float d = padDist(p, c);
    if (d < PAD_R) {
      bool mine = uPadOn > 0.5 && distance(c, uPad) < 0.001;
      vec3 lc = mine ? vec3(1.0, 0.62, 0.2) : vec3(0.35, 0.75, 0.85);
      float pulse = mine ? 0.6 + 0.4 * sin(uTime * 4.0) : 0.5;
      col *= 0.3;                                                       // pad surface
      sig += lc * smoothstep(0.003, 0.0, abs(d - PAD_R * 0.93)) * pulse * 1.4; // outer ring
      sig += lc * smoothstep(0.002, 0.0, abs(d - PAD_R * 0.45)) * pulse * 0.7; // inner ring
      if (mine) sig += lc * 0.08 * pulse;
    }
  }

  // slot tunnel guide lights: green on +x, red on −x, running along it
  if (tunnel) {
    float run = smoothstep(0.3, 0.0, abs(fract(p.z * 40.0 - uTime * 1.5) - 0.5));
    if (N.x < -0.5) sig += vec3(0.2, 1.0, 0.4) * run * 0.8;
    if (N.x > 0.5) sig += vec3(1.0, 0.2, 0.15) * run * 0.8;
  }
  // alpha: the physical share of this pixel, so the exposure meter ignores the signal lights
  // (render/hdr.ts); otherwise they'd hold the exposure down in the dark
  vec3 W = vec3(0.2126, 0.7152, 0.0722);
  gl_FragColor = vec4(col + sig, dot(col, W) / (dot(col + sig, W) + 1e-9));
}
