// Orbital station (render/shaders/station.frag.glsl): a unit cube (−0.5…0.5) of brushed, mirror-like
// metal panels. Reflections sample a tiny procedural sky: black space, the Milky Way band, the star
// as a sharp highlight, the parent world as a soft glow. Physical light is scaled by the exposure;
// signal lights (slot rim, approach and nav lights) are display-referred, added after it.
// #include frame
// #include noise
// #include stationBody

@group(1) @binding(0) var<uniform> so: Obj;

fn envColor(R: vec3f, L: vec3f) -> vec3f {
  let lit = so.v[0].w;
  let gn = normalize(vec3f(0.05, 1.0, 0.12));
  let b = dot(R, gn);
  var c = (vec3f(0.012, 0.014, 0.022) + vec3f(0.07, 0.07, 0.09) * exp(-b * b / 0.02)) * frame.skyK;
  let cp = dot(R, so.v[2].xyz);
  // the world is only bright on its day side, which faces the station only when it's in sunlight
  let ps = so.v[2].w;
  c += so.v[3].rgb * smoothstep(ps - 0.02, ps + 0.01, cp) * 0.35 * lit;
  let rl = max(dot(R, L), 0.0);
  c += so.v[1].rgb * lit * (pow(rl, 900.0) * 30.0 + pow(rl, 60.0) * 0.6);
  return c;
}

@fragment
fn fs(in: BodyOut) -> @location(0) vec4f {
  let seed = so.v[1].w;
  let time = so.v[3].w;
  let lit = so.v[0].w;
  let starC = so.v[1].rgb;
  let planetDir = so.v[2].xyz;
  let planetC = so.v[3].rgb;
  let N = normalize(in.wn);
  let V = normalize(-in.wp);
  let L = normalize(so.v[0].xyz);
  let p = in.obj;
  // face coordinates: the two object axes across the face we're on
  let an = abs(p);
  var uv = p.xy;
  if (an.x > an.y && an.x > an.z) { uv = p.yz; } else if (an.y > an.z) { uv = p.xz; }
  uv += 0.5;
  let front = an.z > an.x && an.z > an.y && p.z > 0.0;

  // hull plates: 10×10 panels with dark seams, each tinted and angled slightly differently
  let cell = floor(uv * 10.0);
  let f = fract(uv * 10.0);
  let seam = smoothstep(0.0, 0.035, f.x) * smoothstep(0.0, 0.035, f.y) * (1.0 - smoothstep(0.965, 1.0, f.x)) * (1.0 - smoothstep(0.965, 1.0, f.y));
  let h = shash(cell, seed);
  let brushed = snoise(vec3f(uv.x * 4.0, uv.y * 260.0, seed)) * 0.5 + 0.5;
  let base = mix(vec3f(0.55, 0.57, 0.6), vec3f(0.72, 0.7, 0.66), h) * (0.85 + 0.15 * brushed);
  // wobble each plate's normal a little so the reflections break up panel by panel
  let Np = normalize(N + 0.035 * vec3f(shash(cell + 1.3, seed) - 0.5, shash(cell + 2.7, seed) - 0.5, shash(cell + 4.1, seed) - 0.5));

  let R = reflect(-V, Np);
  let nv = clamp(dot(Np, V), 0.0, 1.0);
  let F = base + (1.0 - base) * pow(1.0 - nv, 5.0); // Schlick Fresnel for a metal
  let ndl = max(dot(Np, L), 0.0);
  let H = normalize(L + V);
  let gloss = pow(max(dot(Np, H), 0.0), 140.0) * 2.5;
  let planetShine = max(dot(N, planetDir), 0.0) * 0.12 * lit;
  var col = envColor(R, L) * F + base * starC * ndl * lit * 0.55 + F * starC * gloss * lit * ndl + base * planetC * planetShine;
  // the station's own floodlights: pools of warm light from lamps at each face's edge midpoints
  let e = uv - 0.5;
  let e1 = vec2f(abs(e.x) - 0.5, e.y);
  let e2 = vec2f(e.x, abs(e.y) - 0.5);
  let flood = exp(-dot(e1, e1) / 0.06) + exp(-dot(e2, e2) / 0.06);
  col += base * vec3f(1.0, 0.9, 0.75) * flood * frame.floodK;
  col += headlight(Np, in.wp, base, frame.headK);
  col *= mix(0.25, 1.0, seam);
  // scattered windows, so the station is visible on its night side too
  let wc = floor(uv * 60.0);
  let win = step(0.99, shash(wc + 7.0, seed)) * (1.0 - smoothstep(0.1, 0.35, length(fract(uv * 60.0) - 0.5)));
  col += vec3f(1.0, 0.85, 0.6) * win * 0.7 * frame.winK;
  col *= frame.exposure;
  var sig = vec3f(0.0);

  // the docking slot on the front face: a dark recess with a lit rim; approach lights run in toward
  // it along its long axis, green on one side (+x) and red on the other
  if (front) {
    let d = abs(uv - 0.5) - vec2f(0.2, 0.06);
    let slot = step(max(d.x, d.y), 0.0);
    let rim = 1.0 - smoothstep(0.0, 0.012, abs(max(d.x, d.y)));
    col = mix(col, vec3f(0.0), slot);
    sig += vec3f(0.25, 0.9, 0.55) * rim * 0.9;
    let ax = abs(uv.x - 0.5);
    if (ax > 0.21 && abs(uv.y - 0.5) < 0.012) {
      let c = fract(ax * 30.0);
      let lamp = (1.0 - smoothstep(0.0, 0.25, abs(c - 0.5))) * (1.0 - smoothstep(0.0, 0.009, abs(uv.y - 0.5)));
      let run = 0.25 + 0.75 * pow(fract(ax * 3.0 + time * 0.8), 6.0); // pulses running inward
      sig += select(vec3f(1.0, 0.2, 0.15), vec3f(0.2, 1.0, 0.4), uv.x > 0.5) * lamp * run * 2.0;
    }
  }
  // navigation lights at the corners: blinking red / green by side, white strobes top and bottom
  if (an.x > 0.47 && an.y > 0.47 && an.z > 0.47) {
    let blink = step(0.8, fract(time * 0.7 + select(0.5, 0.0, p.z > 0.0)));
    var nc = vec3f(1.0, 0.2, 0.15);
    if (p.y > 0.0) { nc = vec3f(1.0); } else if (p.x > 0.0) { nc = vec3f(0.2, 1.0, 0.4); }
    sig += nc * blink * 3.0;
  }
  return physShare(col, sig);
}
