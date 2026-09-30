// Inside a station (render/shaders/stationInterior.frag.glsl; unit coordinates, sim/stationGeom.ts):
// the slot tunnel, the hangar cylinder and its end walls, lit by lamp rows and the pads' lights. The
// pad granted to you glows amber and pulses, the rest are dim cyan; the tunnel has green lights on
// one side and red on the other. Lamp light is physical (× INT_K × exposure); pad markers and the
// tunnel's guide lights are display-referred signals.
// #include frame
// #include stationBody

@group(1) @binding(0) var<uniform> so: Obj;

const HR: f32 = 0.42;       // HANGAR_R
const PAD_R: f32 = 0.04;
const COLS: f32 = 6.0;      // PAD_COLS

var<private> padC: vec3f;
// distance (unit coordinates, across the wall) to the nearest pad centre on the hangar wall
fn padDist(p: vec3f) -> f32 {
  var best = 1e3;
  let phi = atan2(p.y, p.x);
  let rows = array<f32, 3>(0.2, -0.04, -0.28); // PAD_ROWS
  for (var row = 0; row < 3; row++) {
    let z = rows[row];
    let off = f32(row % 2) * 3.14159265 / COLS;
    let k = floor((phi - off) / (6.2831853 / COLS) + 0.5);
    let a = k * 6.2831853 / COLS + off;
    let da = atan2(sin(phi - a), cos(phi - a));
    let d = length(vec2f(da * HR, p.z - z));
    if (d < best) {
      best = d;
      padC = vec3f(HR * cos(a), HR * sin(a), z);
    }
  }
  return best;
}

@fragment
fn fs(in: BodyOut) -> @location(0) vec4f {
  let p = in.obj;
  let N = normalize(in.wn);
  let time = so.v[3].w;
  let seed = so.v[1].w;
  let r = length(p.xy);
  let wall = abs(r - HR) < 0.004 && p.z < 0.399;
  let tunnel = p.z > 0.399;

  // base: dull grey plating with seams
  var uv = p.xy;
  if (wall) { uv = vec2f(atan2(p.y, p.x) * HR, p.z); } else if (tunnel) { uv = select(p.xz, p.yz, abs(N.x) > 0.5); }
  let cell = floor(uv * 40.0);
  let f = fract(uv * 40.0);
  let seam = smoothstep(0.0, 0.04, f.x) * smoothstep(0.0, 0.04, f.y) * (1.0 - smoothstep(0.96, 1.0, f.x)) * (1.0 - smoothstep(0.96, 1.0, f.y));
  let base = mix(vec3f(0.16, 0.17, 0.18), vec3f(0.22, 0.22, 0.21), shash(cell, seed)) * mix(0.6, 1.0, seam);

  // lamps: bright strips along the hangar wall between pad columns, and around the end walls
  var light = 0.35;
  if (wall) {
    let phi = atan2(p.y, p.x);
    let strip = abs(fract(phi / (6.2831853 / COLS)) - 0.5);
    light += 0.9 * (1.0 - smoothstep(0.0, 0.03, abs(strip - 0.5)));
    light += 0.6 * (1.0 - smoothstep(0.0, 0.015, abs(fract(p.z * 6.0) - 0.5) - 0.47));
  } else if (!tunnel) {
    light += 0.8 * (1.0 - smoothstep(0.0, 0.006, abs(r - HR * 0.96)));
  }
  var col = base * light + headlight(N, in.wp, base, frame.headKi);
  // lamps glow themselves
  if (wall) {
    let strip = fract(atan2(p.y, p.x) / (6.2831853 / COLS));
    col += vec3f(1.0, 0.9, 0.75) * (1.0 - smoothstep(0.0, 0.006, min(strip, 1.0 - strip))) * 0.8;
  }
  col *= frame.intK * frame.exposure;
  var sig = vec3f(0.0);

  // pads on the hangar wall
  if (wall) {
    let d = padDist(p);
    if (d < PAD_R) {
      let mine = so.v[4].w > 0.5 && distance(padC, so.v[4].xyz) < 0.001;
      let lc = select(vec3f(0.35, 0.75, 0.85), vec3f(1.0, 0.62, 0.2), mine);
      let pulse = select(0.5, 0.6 + 0.4 * sin(time * 4.0), mine);
      col *= 0.3;
      sig += lc * (1.0 - smoothstep(0.0, 0.003, abs(d - PAD_R * 0.93))) * pulse * 1.4;
      sig += lc * (1.0 - smoothstep(0.0, 0.002, abs(d - PAD_R * 0.45))) * pulse * 0.7;
      if (mine) { sig += lc * 0.08 * pulse; }
    }
  }
  // slot tunnel guide lights: green on +x, red on −x, running along it
  if (tunnel) {
    let run = 1.0 - smoothstep(0.0, 0.3, abs(fract(p.z * 40.0 - time * 1.5) - 0.5));
    if (N.x < -0.5) { sig += vec3f(0.2, 1.0, 0.4) * run * 0.8; }
    if (N.x > 0.5) { sig += vec3f(1.0, 0.2, 0.15) * run * 0.8; }
  }
  return physShare(col, sig);
}
