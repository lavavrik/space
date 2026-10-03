// The galactic core's black hole (gpu/blackhole.ts, docs/blackhole.md), over the resolved frame: each
// pixel's light ray traced back from the camera through the hole's Schwarzschild field, in Rs units.
// Where it falls in, black (the shadow, ~2.6 Rs); where it crosses the thin accretion disk, the
// disk's light (Doppler-boosted on the side coming toward you, and redshifted by the hole); where it
// escapes, what lies along its bent direction: the frame there if that's on screen and far, else
// the Milky Way. What's nearer than the hole is left as it is.
//
// #include frame
// #include noise

struct Hole {
  cam: vec4f,   // the camera, relative to the hole (Rs); w: Rs (m)
  axis: vec4f,  // the disk's normal; w: its inner edge (Rs)
  disk: vec4f,  // x: its outer edge (Rs); y: the lens's radius (Rs); z: the disk's clock (s); w: brightness
  front: vec4f, // x: depth nearer than which the frame is in front of the hole; y: 1 if the camera's in the lens
}
@group(1) @binding(0) var<uniform> hole: Hole;
@group(1) @binding(1) var sceneTex: texture_2d<f32>;
@group(1) @binding(2) var samp: sampler;
@group(1) @binding(3) var sceneDepth: texture_depth_multisampled_2d;
@group(1) @binding(4) var skyTex: texture_cube<f32>;

const STEPS: i32 = 220;
// past this impact parameter (Rs) the bend is eased out to none at the lens's edge: no seam there
const TAPER_IN: f32 = 0.6;
// the disk's texture is laid down afresh this often (Rs/c of its sped-up clock: ~13 min)
const FLOW_P: f32 = 40.0;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return fullscreen(i);
}

fn depthAtPx(px: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(sceneDepth));
  return textureLoad(sceneDepth, vec2i(clamp(px, vec2f(0.0), dims - 1.0)), 0);
}

// a blackbody's colour (linear, peak 1), by Tanner Helland's fit
fn blackbody(t: f32) -> vec3f {
  let x = clamp(t, 1000.0, 40000.0) / 100.0;
  var c: vec3f;
  if (x <= 66.0) {
    c.r = 1.0;
    c.g = clamp(0.3900816 * log(x) - 0.6318414, 0.0, 1.0);
  } else {
    c.r = clamp(1.292936 * pow(x - 60.0, -0.1332047), 0.0, 1.0);
    c.g = clamp(1.1298909 * pow(x - 60.0, -0.0755148), 0.0, 1.0);
  }
  if (x >= 66.0) { c.b = 1.0; } else if (x <= 19.0) { c.b = 0.0; } else { c.b = clamp(0.5432068 * log(x - 10.0) - 1.1962541, 0.0, 1.0); }
  return pow(c, vec3f(2.2));
}

// What's along world direction `d` far beyond the hole: the frame (its stars too) where that's on
// screen and nothing near covers it, else the Milky Way's cube (as sky.wgsl shades it). w: alpha.
fn background(d: vec3f) -> vec4f {
  let r = frame.camRot;
  let q = vec3f(dot(d, r[0].xyz), dot(d, r[1].xyz), dot(d, r[2].xyz)); // (world → camera)
  if (q.z < -1e-3) {
    let ndc = vec2f(q.x / -q.z * frame.proj.x, q.y / -q.z * frame.proj.y);
    if (abs(ndc.x) < 1.0 && abs(ndc.y) < 1.0) {
      let uv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
      if (depthAtPx(uv * frame.viewport) <= hole.front.x) { return textureSampleLevel(sceneTex, samp, uv, 0.0); }
    }
  }
  let c = textureSampleLevel(skyTex, samp, d, 0.0).rgb;
  return vec4f(c * c * frame.skyExp, 1.0);
}

// fbm with each octave faded out where its features are finer than ~2 px: `unit` is the size (Rs)
// of one unit of `q` on the disk, `fp` a pixel's footprint there (Rs)
fn diskFbm(q: vec3f, unit: f32, fp: f32) -> f32 {
  var a = 0.5;
  var s = 0.0;
  var p = q;
  var size = unit;
  for (var i = 0; i < 6; i++) {
    let w = smoothstep(1.5 * fp, 3.0 * fp, size);
    if (w <= 0.0) { break; }
    s += a * w * snoise(p);
    p = p * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
    size *= 0.4926;
  }
  return s;
}

// One layer of the disk's turbulence, each ring turned by its own angular speed for `t` (Rs/c) since
// the layer was laid down (`seed`): polar coordinates, stretched along the orbits.
fn diskLayer(a0: f32, lr: f32, omega: f32, t: f32, seed: f32, unit: f32, fp: f32) -> f32 {
  let a = a0 - omega * t;
  return diskFbm(vec3f(cos(a) * 1.6, sin(a) * 1.6, lr * 9.0 + seed), unit, fp);
}

// The disk's light where the ray crosses it at `p` (Rs from the centre), going along `v` (traced
// backwards: the light itself goes along −v). Thin-disk temperature, the orbit's Doppler shift and
// beaming, the hole's redshift; turbulent streaks sheared by the orbits (inner ones go round faster).
// `fp`: a pixel's footprint on the disk there (Rs), for the texture's detail.
fn diskLight(p: vec3f, v: vec3f, fp: f32) -> vec4f {
  let n = hole.axis.xyz;
  let rIn = hole.axis.w;
  let rOut = hole.disk.x;
  let r = length(p);
  // temperature: r^−¾ (1 − √(r_in/r))^¼, 1 at its peak (≈ 1.36 r_in)
  let tn = pow(r / rIn, -0.75) * pow(max(1.0 - sqrt(rIn / r), 0.0), 0.25) / 0.488;
  // a circular orbit's speed (c), as a static observer sees it: √(M / (r − 2M)), M = ½
  let beta = sqrt(0.5 / max(r - 1.0, 0.5));
  let gamma = inverseSqrt(1.0 - beta * beta);
  let phiHat = normalize(cross(n, p));
  let g = sqrt(max(1.0 - 1.0 / r, 0.0)) / (gamma * (1.0 - beta * dot(phiHat, -normalize(v))));
  // turbulence (Ω = √(M/r³) in c/Rs; the clock already in Rs/c and sped up). Turned for ever, the
  // shear wound it into rings finer than a pixel (moiré): two layers instead, each laid down afresh
  // every FLOW_P and crossfaded, so it's never wound more than one period's worth
  let e1 = normalize(cross(n, select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.x) > 0.9)));
  let e2 = cross(n, e1);
  let omega = sqrt(0.5 / (r * r * r));
  let a0 = atan2(dot(p, e2), dot(p, e1));
  let lr = log(r);
  let unit = r / 9.0; // (radially, one unit of the layer's coordinates)
  let c1 = hole.disk.z / FLOW_P;
  let c2 = c1 + 0.5;
  let f1 = fract(c1);
  let f2 = fract(c2);
  let w1 = 1.0 - abs(2.0 * f1 - 1.0);
  let w2 = 1.0 - w1;
  let n1 = diskLayer(a0, lr, omega, f1 * FLOW_P, fract(floor(c1) * 0.1031) * 97.0, unit, fp);
  let n2 = diskLayer(a0, lr, omega, f2 * FLOW_P, fract(floor(c2) * 0.1031) * 97.0 + 41.0, unit, fp);
  let s = (n1 * w1 + n2 * w2) * inverseSqrt(w1 * w1 + w2 * w2) * 0.5 + 0.5;
  let dens = clamp(0.2 + 1.2 * s, 0.0, 1.4);
  let edge = smoothstep(rIn, rIn * 1.15, r) * (1.0 - smoothstep(rOut * 0.55, rOut, r));
  let alpha = clamp(dens * edge, 0.0, 0.95);
  let T = 7500.0 * tn * g;
  let I = hole.disk.w * pow(tn, 2.5) * pow(g, 4.0) * dens;
  return vec4f(blackbody(T) * I, alpha);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let src = textureLoad(sceneTex, vec2i(pos.xy), 0);
  if (depthAtPx(pos.xy) > hole.front.x) { return src; } // (in front of the hole)
  let d0 = viewDir(pos.xy);
  let R = hole.disk.y;
  var x = hole.cam.xyz;
  var travel = 0.0; // (Rs along the ray: with the pixel's angle, its footprint)
  let pxA = 2.0 / (frame.proj.y * frame.viewport.y); // (rad per pixel)
  // outside the lens: straight to its sphere, or past it untouched
  if (hole.front.y < 0.5) {
    let b = dot(x, d0);
    let c = dot(x, x) - R * R;
    let h = b * b - c;
    if (h <= 0.0 || b > 0.0) { return src; }
    x += d0 * (-b - sqrt(h));
    travel = -b - sqrt(h);
  }
  var v = d0;
  let L = cross(x, v);
  let h2 = dot(L, L);
  let taper = smoothstep(TAPER_IN * R, R, sqrt(h2));
  let n = hole.axis.xyz;
  var col = vec3f(0.0);
  var trans = 1.0;
  var fell = false;
  for (var i = 0; i < STEPS; i++) {
    let r = length(x);
    if (r < 1.0) { fell = true; break; }
    if (r > R && dot(x, v) > 0.0) { break; }
    // velocity Verlet on x'' = −(3/2) h² x / r⁵, steps growing with r (fine round the photon sphere)
    let dt = clamp(0.07 * r, 0.015, 6.0);
    let a0 = -1.5 * h2 * x / pow(r, 5.0);
    let prev = x;
    x += v * dt + 0.5 * a0 * dt * dt;
    travel += dt;
    let a1 = -1.5 * h2 * x / pow(length(x), 5.0);
    v = normalize(v + 0.5 * (a0 + a1) * dt);
    // through the disk's plane, within the disk: its light over what's behind, front to back
    let s0 = dot(prev, n);
    let s1 = dot(x, n);
    if (s0 * s1 < 0.0) {
      let p = mix(prev, x, s0 / (s0 - s1));
      let rp = length(p);
      if (rp > hole.axis.w && rp < hole.disk.x) {
        // a pixel's footprint there: its angle over the path, wider the more the ray has been bent
        // (images bent round the hole are squeezed: the far side over the top, the rings at the shadow)
        let bend = acos(clamp(dot(v, d0), -1.0, 1.0));
        let e = diskLight(p, v, travel * pxA * (1.0 + 3.0 * bend));
        col += trans * e.a * e.rgb;
        trans *= 1.0 - e.a;
        if (trans < 0.01) { break; }
      }
    }
  }
  var bg = vec4f(0.0, 0.0, 0.0, 1.0);
  if (!fell) { bg = background(normalize(mix(v, d0, taper))); }
  // (the disk is display-referred, as the star is (star.wgsl): alpha 0 keeps it out of the exposure meter)
  return vec4f(col + trans * bg.rgb, trans * bg.a);
}
