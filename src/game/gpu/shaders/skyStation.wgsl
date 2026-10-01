// Sky station (render/skyMesh.ts, sim/skyGeom.ts): a flying carrier hanging in its world's air,
// +z up in object space, the deck's top at z = 0, the bow at +x, in units of its length. Dark deck
// plating with the pads marked and ringed with lights, a dashed centreline, edge lines and lights
// and hazard stripes along the edges, the island's lit bridge, a red beacon, panels and portholes
// on the hull, and the lift fans' glow. Lit by the sun through the air and by the sky, then hazed
// like the ground: its world's uniforms (the air) are bound at group 1.
// #include frame
// #include world
// #include noise
// #include atmo
// #include stationBody

@group(2) @binding(0) var<uniform> so: Obj;

const PADS: i32 = 12;
// (sim/skyGeom.ts)
const HW: f32 = 0.1; // the deck's half-width
const ISL: vec4f = vec4f(-0.07, 0.07, 0.062, 0.095); // the island: x0, x1, y0, y1
const ISL_Z: f32 = 0.075;
const BRIDGE_H: f32 = 0.018;
const HULL_HW: f32 = 0.07;
const POD_Z: f32 = -0.06;
const POD_Y: f32 = 0.085;
const MAST_Z: f32 = 0.11;

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

@fragment
fn fs(in: BodyOut) -> @location(0) vec4f {
  let seed = so.v[1].w;
  let time = so.v[3].w;
  let up = so.v[7].xyz;
  let padR = so.v[6].y;
  let myPad = i32(round(so.v[6].z));
  let p = in.obj;
  var N = normalize(in.wn);
  let V = normalize(-in.wp);
  let L = normalize(so.v[0].xyz);
  if (dot(N, V) < 0.0) { N = -N; } // double-sided
  let nUp = dot(N, up);
  // the face's own axis (object space): which plane to lay the plating in
  let No = normalize(transpose(mat3x3f(so.model[0].xyz, so.model[1].xyz, so.model[2].xyz)) * N);
  let face = select(select(p.yz, p.xz, abs(No.y) > 0.5), p.xy, abs(No.z) > 0.5);
  var sig = vec3f(0.0);
  var emit = vec3f(0.0);
  var base: vec3f;
  var gloss = 0.3;

  let onIsland = p.x > ISL.x - 1e-4 && p.x < ISL.y + 1e-4 && p.y > ISL.z - 1e-4 && p.z > 1e-4 && p.z < ISL_Z + 1e-4;
  let deckTop = abs(p.z) < 1e-4 && nUp > 0.5;
  if (deckTop) {
    // deck plating, a little mottled, with seams
    base = vec3f(0.16, 0.165, 0.17) * panels(p.xy, 50.0, seed);
    gloss = 0.15;
    let paint = vec3f(0.85, 0.85, 0.8);
    // a dashed centreline and a line along each edge
    let dash = step(0.5, fract(p.x * 40.0));
    base = mix(base, paint, (1.0 - smoothstep(0.0012, 0.0022, abs(p.y + 0.009))) * dash * 0.8);
    base = mix(base, paint, (1.0 - smoothstep(0.0015, 0.0025, abs(abs(p.y) - (HW - 0.008)))) * 0.7);
    // hazard stripes along the edges and across the bow and stern
    let edge = max(smoothstep(HW - 0.004, HW - 0.002, abs(p.y)), smoothstep(0.496, 0.498, abs(p.x)));
    let stripe = step(0.5, fract((p.x + p.y) * 120.0));
    base = mix(base, mix(vec3f(0.05), vec3f(0.75, 0.6, 0.1), stripe), edge * 0.8);
    for (var i = 0; i < PADS; i++) {
      let d = p.xy - padPos(i);
      let dl = length(d);
      if (dl > padR * 1.25) { continue; }
      let mine = i == myPad;
      // the pad: a lighter disc with a white ring and a cross
      base = mix(base, vec3f(0.3, 0.31, 0.32), 1.0 - smoothstep(padR * 0.97, padR, dl));
      let ring = 1.0 - smoothstep(0.0, 0.0012, abs(dl - padR * 0.92));
      let crs = step(dl, padR * 0.6) * max(1.0 - smoothstep(0.0, 0.002, abs(d.x)), 1.0 - smoothstep(0.0, 0.002, abs(d.y)));
      base = mix(base, vec3f(0.85), max(ring, crs * 0.8));
      // lamps round its edge: a steady warm ring, or chasing green ones on your pad
      let a = atan2(d.y, d.x) / 6.2832;
      let lamp = (1.0 - smoothstep(0.0, 0.25, abs(fract(a * 16.0) - 0.5))) * (1.0 - smoothstep(0.0, 0.0025, abs(dl - padR)));
      if (mine) {
        sig += vec3f(0.2, 1.0, 0.45) * lamp * (0.4 + 1.6 * pow(fract(a * 2.0 - time * 0.6), 4.0)) * 2.0;
      } else {
        sig += vec3f(1.0, 0.8, 0.5) * lamp * 0.5;
      }
    }
    // edge lights down both sides: white, a slow chase toward the bow
    let el = (1.0 - smoothstep(0.0, 0.3, abs(fract(p.x * 60.0) - 0.5))) * smoothstep(HW - 0.0015, HW - 0.0005, abs(p.y));
    sig += vec3f(1.0, 0.95, 0.85) * el * (0.5 + pow(fract(p.x * 2.0 - time * 0.4), 6.0));
  } else if (p.z > ISL_Z + 1e-4) {
    // the beacon mast: a slow red strobe at its tip
    base = vec3f(0.3);
    if (p.z > MAST_Z - 0.004) { sig += vec3f(1.0, 0.1, 0.05) * step(0.85, fract(time * 0.5)) * 6.0; }
  } else if (onIsland) {
    // the island: plating, rows of small windows, and the bridge's band of lit glass near the top
    base = vec3f(0.46, 0.47, 0.5) * panels(face, 90.0, seed);
    gloss = 0.5;
    if (abs(No.z) < 0.5) {
      let along = select(p.x, p.y, abs(No.x) > 0.5);
      let bridge = smoothstep(ISL_Z - BRIDGE_H, ISL_Z - BRIDGE_H + 0.001, p.z) * (1.0 - smoothstep(ISL_Z - 0.005, ISL_Z - 0.004, p.z)) * step(0.1, fract(along * 300.0));
      let q = vec2f(along * 400.0, p.z * 250.0);
      let rows = step(p.z, ISL_Z - BRIDGE_H - 0.004) * step(0.6, shash(floor(q), seed + 4.0)) * (1.0 - smoothstep(0.2, 0.35, abs(fract(q.y) - 0.5)));
      base *= 1.0 - bridge * 0.9;
      emit += vec3f(1.0, 0.85, 0.6) * (bridge * 1.5 + rows * 0.8) * frame.winK;
    }
  } else {
    // metal panels (the deck's sides and underside, the hull, the pods)
    base = mix(vec3f(0.42, 0.43, 0.45), vec3f(0.55, 0.54, 0.5), shash(floor(face * 60.0), seed)) * panels(face, 60.0, seed);
    gloss = 0.6;
    // portholes in rows along the hull's sides
    if (abs(abs(p.y) - HULL_HW) < 1e-4 && p.z < -0.025 && p.z > -0.085) {
      let q = vec2f(p.x * 300.0, p.z * 110.0);
      let w = step(0.55, shash(floor(q) + 3.1, seed)) * (1.0 - smoothstep(0.15, 0.3, length(fract(q) - 0.5)));
      emit += vec3f(1.0, 0.85, 0.6) * w * frame.winK;
    }
    // running lights along the deck's sides: white, blinking
    if (abs(abs(p.y) - HW) < 1e-4 && p.z > -0.015 && p.z < -0.005) {
      let l = 1.0 - smoothstep(0.0, 0.3, abs(fract(p.x * 80.0) - 0.5));
      sig += vec3f(1.0, 0.95, 0.85) * l * step(0.5, fract(time * 0.8 + p.x * 3.0)) * 1.5;
    }
  }
  // the lift fans' exhaust glow under the pods
  if (abs(p.z - POD_Z) < 1e-4 && nUp < -0.5) {
    let px = p.x - round(p.x / 0.33) * 0.33;
    let py = p.y - sign(p.y) * POD_Y;
    let fan = 0.5 + 0.5 * sin(atan2(py, px) * 7.0 + time * 20.0);
    base = vec3f(0.1);
    sig += vec3f(0.4, 0.7, 1.0) * (0.5 + 0.3 * fan);
  }

  // sunlight through the air, skylight by day, a little floodlight on the deck at night
  let sunC = atSunlight(in.wp, L) * shadowAt(in.wp, N);
  let ndl = max(dot(N, L), 0.0);
  let day = smoothstep(-0.12, 0.35, dot(up, L));
  let sky = select(0.0, 0.07 * day * (0.6 + 0.4 * nUp), world.atOn > 0.5);
  let H = normalize(L + V);
  let spec = pow(max(dot(N, H), 0.0), 60.0) * gloss;
  var col = base * (ndl * sunC + sky + 0.0002) + sunC * spec * ndl;
  // a pair's second sun, in its colour (docs/binaries.md)
  if (so.v[14].w > 0.5) {
    let L2 = so.v[14].xyz;
    col += base * max(dot(N, L2), 0.0) * atSunlight(in.wp, L2) * so.v[15].rgb * shadowAt2(in.wp, N);
  }
  if (deckTop) { col += base * vec3f(1.0, 0.9, 0.75) * frame.floodK * 0.6; }
  col += headlight(N, in.wp, base, frame.headK);
  col += emit;
  // the air between here and the camera
  if (world.atOn > 0.5) {
    let haze = atInscatter(vec3f(0.0), in.wp, L, 5);
    col = col * atTrans + haze;
    sig *= atTrans;
  }
  col *= frame.exposure;
  return physShare(col, sig);
}
