// Depot (render/depotMesh.ts, sim/depotGeom.ts): a station parked in open space at a Lagrange point.
// A round landing plate at the +x end of a truss spine, 8 pads painted on it and ringed with lamps;
// a tank farm of reflective spheres at the −x end, radiator fins, solar wings, a habitat block with
// lit windows, a strobing beacon mast. Vacuum lighting like the orbital station's: the star, a
// black sky with the Milky Way band for the reflections, no air and no world. Physical light is
// scaled by the exposure; signal lights are display-referred, added after it.
// #include frame
// #include noise
// #include stationBody

@group(1) @binding(0) var<uniform> so: Obj;

const PADS: i32 = 8;
// (sim/depotGeom.ts)
const PLATE_X: f32 = 0.3;
const PLATE_R: f32 = 0.19;
const SPINE_ZC: f32 = -0.0625;
const SPINE_HW: f32 = 0.022;
const WING_Z: f32 = -0.0625;
const FIN_Y: f32 = 0.05;
const MAST_X: f32 = -0.5;
const MAST_Z: f32 = 0.13;
const SPINE_X_LIGHT: f32 = -0.49;

fn padPos(i: i32) -> vec2f {
  let v = so.v[8 + i / 2];
  return select(v.xy, v.zw, (i % 2) == 1);
}

// plating on a face (`uv` in its plane): ~1, dimmer on the seams
fn panels(uv: vec2f, k: f32, seed: f32) -> f32 {
  let q = uv * k;
  let f = fract(q);
  let seam = smoothstep(0.0, 0.05, f.x) * smoothstep(0.0, 0.05, f.y) * (1.0 - smoothstep(0.95, 1.0, f.x)) * (1.0 - smoothstep(0.95, 1.0, f.y));
  return (0.85 + 0.3 * shash(floor(q), seed)) * mix(0.55, 1.0, seam);
}

// which tank (0–7) a point on a sphere belongs to, or −1: the nearest centre, if the point is on its surface
fn tankOf(p: vec3f) -> i32 {
  var best = -1;
  for (var i = 0; i < 8; i++) {
    let ring = i / 4;
    let r = select(0.058, 0.046, ring == 1);
    let off = select(0.075, 0.066, ring == 1);
    let x = select(-0.43, -0.29, ring == 1);
    let k = i % 4;
    var d = vec2f(1.0, 0.0);
    if (k == 1) { d = vec2f(0.0, 1.0); } else if (k == 2) { d = vec2f(-1.0, 0.0); } else if (k == 3) { d = vec2f(0.0, -1.0); }
    let c = vec3f(x, d.x * off, SPINE_ZC + d.y * off);
    if (abs(length(p - c) - r) < 0.0012) { best = i; }
  }
  return best;
}

// the environment seen in a mirror: black space, the Milky Way's band, the star as a sharp highlight
fn envColor(R: vec3f, L: vec3f) -> vec3f {
  let lit = so.v[0].w;
  let gn = normalize(vec3f(0.05, 1.0, 0.12));
  let b = dot(R, gn);
  var c = (vec3f(0.012, 0.014, 0.022) + vec3f(0.07, 0.07, 0.09) * exp(-b * b / 0.02)) * frame.skyK;
  let rl = max(dot(R, L), 0.0);
  c += so.v[1].rgb * lit * (pow(rl, 900.0) * 30.0 + pow(rl, 60.0) * 0.6);
  return c;
}

@fragment
fn fs(in: BodyOut) -> @location(0) vec4f {
  let seed = so.v[1].w;
  let time = so.v[3].w;
  let padR = so.v[6].y;
  let myPad = i32(round(so.v[6].z));
  let p = in.obj;
  var N = normalize(in.wn);
  let V = normalize(-in.wp);
  let L = normalize(so.v[0].xyz);
  if (dot(N, V) < 0.0) { N = -N; } // double-sided
  let lit = so.v[0].w * shadowAt(in.wp, N);
  let starC = so.v[1].rgb;
  // the face's own axis (object space): which plane to lay the plating in
  let No = normalize(transpose(mat3x3f(so.model[0].xyz, so.model[1].xyz, so.model[2].xyz)) * N);
  let face = select(select(p.yz, p.xz, abs(No.y) > 0.5), p.xy, abs(No.z) > 0.5);
  var sig = vec3f(0.0);
  var emit = vec3f(0.0);
  var base = vec3f(0.5);
  var gloss = 0.4;
  var mirror = 0.0; // how much of the environment it reflects

  let rp = length(p.xy - vec2f(PLATE_X, 0.0));
  let onPlate = rp < PLATE_R + 1e-4 && p.z > -0.0145 && p.z < 1e-4 && p.x > 0.1;
  let plateTop = onPlate && abs(p.z) < 1e-4 && No.z > 0.5;
  let tank = tankOf(p);
  let onWing = abs(p.z - WING_Z) < 0.0045 && abs(p.y) > 0.059 && p.x > -0.205 && p.x < -0.035;
  let onFin = p.z < -0.084 && abs(abs(p.y) - FIN_Y) < 0.0045 && p.x > -0.025 && p.x < 0.145;
  let onHab = p.x > 0.199 && p.x < 0.401 && abs(p.y) < 0.0505 && p.z < -0.039 && p.z > -0.1305 && !onPlate;
  let onMast = p.z > -0.04 && abs(p.x - MAST_X) < 0.006 && abs(p.y) < 0.006 && p.z > 1e-3;

  if (plateTop) {
    // dark plating with seams, a dashed ring road, the pads each with a ring, a cross and lamps
    base = vec3f(0.15, 0.155, 0.16) * panels(p.xy * 1.0, 50.0, seed);
    gloss = 0.15;
    let paint = vec3f(0.85, 0.85, 0.8);
    // hazard stripes round the rim and a painted ring at the rim's inner edge
    let rim = smoothstep(PLATE_R - 0.012, PLATE_R - 0.008, rp);
    let stripe = step(0.5, fract(atan2(p.y, p.x - PLATE_X) * 38.0));
    base = mix(base, mix(vec3f(0.05), vec3f(0.75, 0.6, 0.1), stripe), rim * 0.85);
    base = mix(base, paint, (1.0 - smoothstep(0.0012, 0.0022, abs(rp - (PLATE_R - 0.018)))) * 0.7);
    for (var i = 0; i < PADS; i++) {
      let d = p.xy - padPos(i);
      let dl = length(d);
      if (dl > padR * 1.25) { continue; }
      let mine = i == myPad;
      base = mix(base, vec3f(0.3, 0.31, 0.32), 1.0 - smoothstep(padR * 0.97, padR, dl));
      let ring = 1.0 - smoothstep(0.0, 0.0012, abs(dl - padR * 0.92));
      let crs = step(dl, padR * 0.6) * max(1.0 - smoothstep(0.0, 0.002, abs(d.x)), 1.0 - smoothstep(0.0, 0.002, abs(d.y)));
      base = mix(base, vec3f(0.85), max(ring, crs * 0.8));
      let a = atan2(d.y, d.x) / 6.2832;
      let lamp = (1.0 - smoothstep(0.0, 0.25, abs(fract(a * 16.0) - 0.5))) * (1.0 - smoothstep(0.0, 0.0025, abs(dl - padR)));
      if (mine) {
        sig += vec3f(0.2, 1.0, 0.45) * lamp * (0.4 + 1.6 * pow(fract(a * 2.0 - time * 0.6), 4.0)) * 2.0;
      } else {
        sig += vec3f(1.0, 0.8, 0.5) * lamp * 0.5;
      }
    }
    // a chase of white edge lights round the rim
    let el = (1.0 - smoothstep(0.0, 0.3, abs(fract(atan2(p.y, p.x - PLATE_X) * 9.0) - 0.5))) * smoothstep(PLATE_R - 0.004, PLATE_R - 0.002, rp);
    sig += vec3f(1.0, 0.95, 0.85) * el * (0.5 + pow(fract(atan2(p.y, p.x - PLATE_X) * 0.159 - time * 0.4), 6.0));
  } else if (tank >= 0) {
    // propellant tanks: pale, mirror-bright, with a band round the middle and frost
    base = vec3f(0.74, 0.75, 0.78) * (0.9 + 0.1 * shash(floor(p.yz * 90.0), seed));
    mirror = 0.55;
    gloss = 0.8;
    let band = 1.0 - smoothstep(0.0, 0.004, abs(p.x - select(-0.43, -0.29, tank >= 4)));
    base = mix(base, vec3f(0.85, 0.5, 0.15), band * 0.55);
  } else if (onWing) {
    // solar cells: deep blue in a grid, a pale frame
    let q = fract(p.xy * vec2f(40.0, 60.0));
    let cell = smoothstep(0.0, 0.08, q.x) * smoothstep(0.0, 0.08, q.y) * (1.0 - smoothstep(0.92, 1.0, q.x)) * (1.0 - smoothstep(0.92, 1.0, q.y));
    base = mix(vec3f(0.55, 0.57, 0.6), vec3f(0.05, 0.09, 0.2) * (0.8 + 0.4 * shash(floor(p.xy * vec2f(40.0, 60.0)), seed)), cell) * select(0.5, 1.0, No.z > 0.0);
    gloss = 0.9;
    mirror = 0.35 * cell;
  } else if (onFin) {
    // radiator fins: pale panels ribbed along their length
    base = vec3f(0.78, 0.78, 0.76) * (0.8 + 0.2 * step(0.5, fract(p.z * 80.0)));
    gloss = 0.3;
  } else if (onHab) {
    // habitat block: plating and rows of lit windows
    base = vec3f(0.46, 0.47, 0.5) * panels(face, 80.0, seed);
    gloss = 0.4;
    if (abs(No.z) < 0.5) {
      let along = select(p.x, p.y, abs(No.x) > 0.5);
      let q = vec2f(along * 200.0, p.z * 160.0);
      let rows = step(0.55, shash(floor(q), seed + 4.0)) * (1.0 - smoothstep(0.2, 0.35, abs(fract(q.y) - 0.5))) * (1.0 - smoothstep(0.25, 0.4, abs(fract(q.x) - 0.5)));
      emit += vec3f(1.0, 0.85, 0.6) * rows * 0.9 * frame.winK;
    }
  } else if (onMast) {
    base = vec3f(0.3);
    if (p.z > MAST_Z - 0.01) { sig += vec3f(1.0, 0.1, 0.05) * step(0.85, fract(time * 0.5)) * 6.0; }
  } else if (onPlate) {
    // the plate's rim and underside, and the stalk's collar
    base = mix(vec3f(0.42, 0.43, 0.45), vec3f(0.55, 0.54, 0.5), shash(floor(face * 60.0), seed)) * panels(face, 60.0, seed);
    gloss = 0.6;
    mirror = 0.2;
  } else {
    // the spine truss: dark struts in diagonal bays over metal
    base = mix(vec3f(0.42, 0.43, 0.45), vec3f(0.55, 0.54, 0.5), shash(floor(face * 40.0), seed)) * panels(face, 40.0, seed);
    gloss = 0.5;
    mirror = 0.15;
    if (abs(No.z) < 0.5 || abs(No.y) < 0.5) {
      let u = p.x * 90.0;
      let w = select(p.z, p.y, abs(No.z) > 0.5) * 90.0;
      let diag = min(abs(fract(u + w) - 0.5), abs(fract(u - w) - 0.5));
      base *= mix(0.4, 1.0, smoothstep(0.0, 0.1, diag));
    }
    // running lights at the spine's ends: red at the tank end, green by the plate
    if (p.x < SPINE_X_LIGHT) { sig += vec3f(1.0, 0.2, 0.15) * step(0.8, fract(time * 0.7)) * 2.0; }
  }

  let ndl = max(dot(N, L), 0.0);
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 80.0) * gloss;
  let R = reflect(-V, N);
  let nv = clamp(dot(N, V), 0.0, 1.0);
  let F = base + (1.0 - base) * pow(1.0 - nv, 5.0);
  var col = base * (ndl * lit * 0.8 + 0.0003) + starC * spec * ndl * lit;
  col += envColor(R, L) * F * mirror;
  // a pair's second sun, in its colour (docs/binaries.md)
  if (so.v[14].w > 0.5) {
    let L2 = so.v[14].xyz;
    col += base * max(dot(N, L2), 0.0) * so.v[15].rgb * starC * shadowAt2(in.wp, N);
  }
  if (plateTop) { col += base * vec3f(1.0, 0.9, 0.75) * frame.floodK * 0.6; }
  col += headlight(N, in.wp, base, frame.headK);
  col += emit;
  col *= frame.exposure;
  return physShare(col, sig);
}
