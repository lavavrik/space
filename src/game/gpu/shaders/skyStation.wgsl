// Sky station (render/shaders/skyStation.frag.glsl; render/skyMesh.ts, sim/skyGeom.ts): an open deck
// hanging in its world's air, +z up in object space, the deck's top at z = 0. Dark deck plating with
// the pads marked and ringed with lights, the tower's lit cab, a red beacon, panels underneath and
// the lift fans' glow. Lit by the sun through the air and by the sky, then hazed like the ground:
// its world's uniforms (the air) are bound at group 1.
// #include frame
// #include world
// #include atmo
// #include stationBody

@group(2) @binding(0) var<uniform> so: Obj;

const PADS: i32 = 12;

fn padPos(i: i32) -> vec2f {
  let v = so.v[8 + i / 2];
  return select(v.xy, v.zw, (i % 2) == 1);
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
  let r = length(p.xy);
  let ang = atan2(p.y, p.x);
  var sig = vec3f(0.0);
  var emit = vec3f(0.0);
  var base: vec3f;
  var gloss = 0.3;

  let deckTop = abs(p.z) < 1e-4 && nUp > 0.5;
  if (deckTop) {
    // deck plating: 20 m plates, a little mottled, with seams
    let cell = floor(p.xy * 50.0);
    let f = fract(p.xy * 50.0);
    let seam = smoothstep(0.0, 0.04, f.x) * smoothstep(0.0, 0.04, f.y) * (1.0 - smoothstep(0.96, 1.0, f.x)) * (1.0 - smoothstep(0.96, 1.0, f.y));
    base = vec3f(0.16, 0.165, 0.17) * (0.85 + 0.3 * shash(cell, seed)) * mix(0.6, 1.0, seam);
    gloss = 0.15;
    // a painted walkway ring between the inner and outer pads, and hazard stripes round the rim
    base = mix(base, vec3f(0.5, 0.45, 0.2), (1.0 - smoothstep(0.0, 0.004, abs(r - 0.275) - 0.003)) * 0.6);
    let stripe = step(0.5, fract(ang * 40.0 / 6.2832));
    base = mix(base, mix(vec3f(0.05), vec3f(0.75, 0.6, 0.1), stripe), smoothstep(0.478, 0.482, r) * 0.8);
    for (var i = 0; i < PADS; i++) {
      let d = p.xy - padPos(i);
      let dl = length(d);
      if (dl > padR * 1.25) { continue; }
      let mine = i == myPad;
      // the pad: a lighter disc with a white ring and a cross
      base = mix(base, vec3f(0.3, 0.31, 0.32), 1.0 - smoothstep(padR * 0.97, padR, dl));
      let ring = 1.0 - smoothstep(0.0, 0.0015, abs(dl - padR * 0.92));
      let crs = step(dl, padR * 0.6) * max(1.0 - smoothstep(0.0, 0.0025, abs(d.x)), 1.0 - smoothstep(0.0, 0.0025, abs(d.y)));
      base = mix(base, vec3f(0.85), max(ring, crs * 0.8));
      // lamps round its edge: a steady warm ring, or chasing green ones on your pad
      let a = atan2(d.y, d.x) / 6.2832;
      let lamp = (1.0 - smoothstep(0.0, 0.25, abs(fract(a * 16.0) - 0.5))) * (1.0 - smoothstep(0.0, 0.003, abs(dl - padR)));
      if (mine) {
        sig += vec3f(0.2, 1.0, 0.45) * lamp * (0.4 + 1.6 * pow(fract(a * 2.0 - time * 0.6), 4.0)) * 2.0;
      } else {
        sig += vec3f(1.0, 0.8, 0.5) * lamp * 0.5;
      }
    }
  } else if (p.z > 0.1399 && r < 0.0049) {
    // the beacon mast's tip: a slow red strobe
    base = vec3f(0.3);
    if (p.z > 0.195) { sig += vec3f(1.0, 0.1, 0.05) * step(0.85, fract(time * 0.5)) * 6.0; }
  } else if (p.z > 0.1 && p.z < 0.14 && r > 0.074) {
    // the control cab: a band of lit windows
    base = vec3f(0.45, 0.47, 0.5);
    let win = smoothstep(0.108, 0.112, p.z) * (1.0 - smoothstep(0.128, 0.132, p.z)) * step(0.12, fract(ang * 24.0 / 6.2832));
    base *= 1.0 - win * 0.9;
    emit += vec3f(1.0, 0.85, 0.6) * win * frame.winK * 1.5;
    gloss = 0.5;
  } else {
    // metal panels (tower, rim, underside, keel, pods)
    let uv = vec2f(ang * 0.5 / 3.14159 * 60.0, p.z * 60.0 + r * 30.0);
    let cell = floor(uv);
    let f = fract(uv);
    let seam = smoothstep(0.0, 0.05, f.x) * smoothstep(0.0, 0.05, f.y) * (1.0 - smoothstep(0.95, 1.0, f.x)) * (1.0 - smoothstep(0.95, 1.0, f.y));
    base = mix(vec3f(0.42, 0.43, 0.45), vec3f(0.55, 0.54, 0.5), shash(cell, seed)) * mix(0.55, 1.0, seam);
    gloss = 0.6;
    // lit portholes round the keel
    if (p.z < -0.04 && p.z > -0.2 && nUp < -0.1) {
      let q = vec2f(ang * 80.0 / 6.2832, p.z * 90.0);
      let w = step(0.8, shash(floor(q) + 3.1, seed)) * (1.0 - smoothstep(0.15, 0.35, length(fract(q) - 0.5)));
      emit += vec3f(1.0, 0.85, 0.6) * w * frame.winK;
    }
    // the rim's lights: white, blinking
    if (abs(r - 0.5) < 0.001 && p.z > -0.02 && p.z < -0.01) {
      let l = 1.0 - smoothstep(0.0, 0.3, abs(fract(ang * 48.0 / 6.2832) - 0.5));
      sig += vec3f(1.0, 0.95, 0.85) * l * step(0.5, fract(time * 0.8 + ang)) * 1.5;
    }
  }
  // the lift fans' exhaust glow under the pods
  if (abs(p.z + 0.12) < 1e-4 && nUp < -0.5) {
    let fan = 0.5 + 0.5 * sin(atan2(p.y - sign(p.y) * 0.318, p.x - sign(p.x) * 0.318) * 7.0 + time * 20.0);
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
