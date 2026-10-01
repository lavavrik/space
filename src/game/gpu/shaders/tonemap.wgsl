// The final pass to the screen (gpu/post.ts; docs/post.md): the frame, blurred toward where you're
// heading in FTL; the volumetric clouds laid over it (vclouds.wgsl: scene × what they let through +
// their light, upsampled); bloom (bloom.wgsl) and the star's lens-flare ghosts; then linear up to 0.8 and a soft shoulder toward 1 per channel, so over-bright light rolls
// off to white instead of clipping flat. Written as is to the canvas: the colours are display values.

struct Post {
  a: vec4f, // clouds on, bloom strength, flare strength, blur strength
  b: vec4f, // the screen point you're heading for (uv), whether it's in front (1) or behind (−1); w: the canvas's width (px)
  c: vec4f, // the star on screen (uv); z: its flare's strength (0 off screen, fading in from the edges); w: the canvas's height (px)
  d: vec4f, // a pair's other star likewise (docs/binaries.md); z: 0 with one star
  e: vec4f, // x: how many warps are set
  // FTL entries and exits (gpu/post.ts warpsOf): the warp's centre (uv), its size (screen heights)
  // and its age (0…1)
  warps: array<vec4f, 8>,
  // …and each one's depth (reversed-Z: NEAR / distance; 1 for yours, round the camera): it bends
  // only what's behind it
  warpD: array<vec4f, 2>,
  // the sea's reflections (seaReflect): the nearest sea world's centre (camera-relative, m) and its
  // radius (the water's surface; 0: none), and the camera-relative view-projection and its inverse
  sea: vec4f,
  vp: mat4x4f,
  ivp: mat4x4f,
  // a lightning bolt near you (sim/lightning.ts boltPath, gpu/post.ts boltOf): its screen box
  // (min uv, max uv); x: how bright it is now, y: how many points, z: the whole view's flash from it;
  // its points: uv, view depth (≤ 0: behind you), w 1 where a new strand starts
  bolt: vec4f,
  boltK: vec4f,
  boltP: array<vec4f, 48>,
  // a rainbow (gpu/post.ts bowOf): the direction away from the sun (camera-relative), w: how strong
  bow: vec4f,
}

// A rainbow's colour at `ang` degrees from the point opposite the sun: the primary bow (violet at
// 40.6°, red at 42.4°), the secondary (reversed, 50.3–53.5°, at a third), Alexander's dark band
// between them, and the sky a little brighter inside the primary
fn rainbow(ang: f32) -> vec3f {
  let x1 = clamp((ang - 40.6) / 1.8, 0.0, 1.0);
  let p = smoothstep(40.2, 40.8, ang) * (1.0 - smoothstep(42.2, 42.9, ang));
  let x2 = clamp((53.5 - ang) / 3.2, 0.0, 1.0);
  let s = smoothstep(50.0, 50.6, ang) * (1.0 - smoothstep(53.2, 53.9, ang));
  let inside = 0.12 * (1.0 - smoothstep(25.0, 40.5, ang)) * step(ang, 40.6);
  let dark = -0.06 * smoothstep(42.6, 44.0, ang) * (1.0 - smoothstep(48.5, 50.0, ang));
  // (paled a little: each colour's band overlaps its neighbours', the sun being a disc, not a point)
  return mix(spectrum(x1), vec3f(0.6), 0.3) * p + mix(spectrum(x2), vec3f(0.6), 0.4) * s * 0.25 + vec3f(inside + dark);
}
// violet (0) … red (1)
fn spectrum(x: f32) -> vec3f {
  return clamp(vec3f(smoothstep(0.45, 0.85, x) + 0.35 * (1.0 - smoothstep(0.0, 0.2, x)), 1.0 - abs(x - 0.55) * 2.6, 1.0 - smoothstep(0.15, 0.5, x)), vec3f(0.0), vec3f(1.0));
}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var clouds: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;
@group(0) @binding(4) var bloom: texture_2d<f32>;
@group(0) @binding(5) var sceneDepth: texture_depth_multisampled_2d;

// the scene's depth at `uv` (reversed-Z: larger is nearer; 0 where nothing was drawn)
fn depthAt(uv: vec2f) -> f32 {
  let dims = vec2f(textureDimensions(sceneDepth));
  return textureLoad(sceneDepth, vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0)), 0);
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// The sea mirrors what's on screen (docs/water.md): the water's own shader mirrors the sky and the
// cloud deck, but not the land, ships or stations, which only the frame has. Here, where the pixel
// is the sea's surface (the depth's point lies at the water's radius, within a few cm per km), the
// ray mirrored off it (off the flat surface: the waves' ripples come back as a vertical smear) is
// traced across the screen through the depth buffer: 24 steps growing 1.35× from 1 % of the
// distance, then halved 5 times onto the surface it went behind. Where it hits, that's what the
// water mirrors, by Fresnel, fading toward the screen's edges (what's off screen can't be seen);
// where it doesn't (the sky, off screen), the water keeps its own sky.
const SSR_NEAR: f32 = 0.5; // (GpuRenderer's NEAR: depth = NEAR / view depth)
fn ssrHit(P: vec3f, R: vec3f, t: f32) -> vec4f {
  // (x, y: the screen point; z: how far the ray is behind what's drawn there (m, > 0 behind); w: 0
  // off screen or behind the camera)
  let q = post.vp * vec4f(P + R * t, 1.0);
  if (q.w <= 1e-3) { return vec4f(0.0); }
  let s = vec2f(q.x / q.w * 0.5 + 0.5, 0.5 - q.y / q.w * 0.5);
  if (any(s < vec2f(0.0)) || any(s > vec2f(1.0))) { return vec4f(0.0); }
  let sd = depthAt(s);
  return vec4f(s, select(-1e9, q.w - SSR_NEAR / max(sd, 1e-9), sd > 0.0), 1.0);
}
fn seaReflect(uv: vec2f, c: vec3f, a: f32) -> vec3f {
  if (post.sea.w <= 0.0) { return c; }
  // (the sea marks itself, alpha 0.5, planet.wgsl: by the depth's point at the water's radius, the
  // water near a coast missed out, its big far triangles lifted by the land's heights at their
  // corners; a blend of it with land or sky at an edge reads as neither)
  if (abs(a - 0.5) > 0.06) { return c; }
  let d0 = depthAt(uv);
  if (d0 <= 0.0) { return c; }
  let h = post.ivp * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, d0, 1.0);
  let P = h.xyz / h.w;
  let dist = length(P);
  let N = normalize(P - post.sea.xyz);
  let V = P / dist;
  let F = 0.02 + 0.98 * pow(1.0 - max(-dot(V, N), 0.0), 5.0);
  let R = reflect(V, N);
  var t = max(0.5, dist * 0.01);
  var tPrev = 0.0;
  var hit = vec4f(0.0);
  for (var i = 0; i < 24; i++) {
    let s = ssrHit(P, R, t);
    if (s.w == 0.0) { break; }
    if (s.z > 0.0 && s.z < max((t - tPrev) * 2.0, t * 0.05)) {
      var lo = tPrev;
      var hi = t;
      for (var k = 0; k < 5; k++) {
        let m = 0.5 * (lo + hi);
        let sm = ssrHit(P, R, m);
        if (sm.w > 0.0 && sm.z > 0.0) { hi = m; } else { lo = m; }
      }
      hit = ssrHit(P, R, hi);
      break;
    }
    tPrev = t;
    t *= 1.35;
  }
  if (hit.w == 0.0) { return c; }
  // (the sea itself, where a ray skimming the horizon met the water beyond, the world curving down:
  // that's the sky's to mirror, which the water's own shader has)
  if (abs(textureSampleLevel(hdr, samp, hit.xy, 0.0).a - 0.5) < 0.06) { return c; }
  let e = min(min(hit.x, 1.0 - hit.x), min(hit.y, 1.0 - hit.y));
  let fade = smoothstep(0.0, 0.06, e);
  // (smeared up and down as ripples stretch a reflection, more the farther it is)
  let o = clamp(0.002 + dist * 2e-6, 0.002, 0.012);
  var rc = vec3f(0.0);
  for (var k = -2; k <= 2; k++) { rc += max(textureSampleLevel(hdr, samp, hit.xy + vec2f(0.0, f32(k) * o), 0.0).rgb, vec3f(0.0)); }
  return mix(c, rc / 5.0, F * fade * 0.9);
}

// a star's lens-flare ghosts at `uv`, for the star at `sp` on screen
fn flare(sp: vec2f, uv: vec2f, size: vec2f) -> vec3f {
  // (behind clouds: as much of it as they let through)
  let through = select(1.0, textureSampleLevel(clouds, samp, sp, 0.0).a, post.a.x > 0.5);
  // (capped at what the star's disc gives against black space, star.wgsl's 1.2: seen through the
  // air the sky draws it brighter, atmosphere.wgsl, and the ghosts blazed)
  let src = clamp(textureSampleLevel(hdr, samp, sp, 0.0).rgb - vec3f(0.8), vec3f(0.0), vec3f(0.4)) * 0.6 * through;
  if (max(src.r, max(src.g, src.b)) <= 0.0) { return vec3f(0.0); }
  let aspect = size.x / size.y;
  let axis = vec2f(0.5) - sp;
  let pos = array<f32, 4>(0.6, 1.1, 1.5, 1.9);
  let rad = array<f32, 4>(0.02, 0.045, 0.03, 0.07);
  let tint = array<vec3f, 4>(vec3f(1.0, 0.8, 0.6), vec3f(0.6, 0.9, 1.0), vec3f(0.9, 0.6, 1.0), vec3f(0.7, 1.0, 0.7));
  var fl = vec3f(0.0);
  for (var i = 0; i < 4; i++) {
    let g = sp + axis * pos[i];
    let d = length((uv - g) * vec2f(aspect, 1.0)) / rad[i];
    fl += tint[i] * (1.0 - smoothstep(0.7, 1.0, d)) * (0.4 + 0.6 * d * d);
  }
  return fl * src;
}

// Space warping where a drive's field forms or collapses (FTL in or out, docs/post.md): the view
// bent round it as round a lens. A ring of compressed space runs out from the centre and fades, and
// while the field is strong the middle pinches light in round it (an Einstein-ring-like bend). It
// returns how far to shift the sample (uv) here, and how strong the ring is (for its faint glow).
fn warpAt(uv: vec2f, size: vec2f) -> vec3f {
  let asp = size.x / size.y;
  var off = vec2f(0.0);
  var glow = 0.0;
  let n = i32(post.e.x + 0.5);
  if (n == 0) { return vec3f(0.0); }
  // only what's behind a warp bends (a rock in front of a ship dropping out of FTL stays as it is:
  // the warp showed through a ring's belt as if in front)
  let here = depthAt(uv);
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    if (here > post.warpD[i / 4][i % 4] * 1.0001) { continue; }
    let w = post.warps[i];
    let d = (uv - w.xy) * vec2f(asp, 1.0);
    let r = length(d);
    let R = w.z;
    if (r > R * 1.3) { continue; }
    let dir = d / max(r, 1e-5);
    let u = w.w;
    let A = (1.0 - u) * (1.0 - u);
    // the ring: out from the centre, wider as it goes
    let ringR = R * (0.1 + 0.9 * sqrt(u));
    let wd = R * (0.06 + 0.16 * u);
    let x = (r - ringR) / wd;
    let ring = exp(-x * x) * A;
    // the pinch: strongest at the start, gone by half way
    // (a bounded profile, ~E²/r outside E and down to nothing at the centre: 1/r there swirled the
    // middle into a knot)
    let E = R * 0.12 * max(0.0, 1.0 - 2.0 * u);
    let q = r / max(E, 1e-5);
    let lens = E * q / (1.0 + q * q) * (1.0 - smoothstep(R * 0.5, R * 1.2, r));
    off += dir / vec2f(asp, 1.0) * (ring * R * 0.16 * x - lens * 0.5);
    glow += ring * 0.5;
  }
  // (nor is something in front pulled in from beside it: where the shifted sample lands nearer than
  // the nearest warp, the view is left alone)
  var nearest = 0.0;
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
    nearest = max(nearest, post.warpD[i / 4][i % 4]);
  }
  if (dot(off, off) > 0.0 && depthAt(uv + off) > nearest * 1.0001) { return vec3f(0.0, 0.0, glow); }
  return vec3f(off, glow);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  // (the scene may be rendered smaller than the canvas, gpu/dynres.ts: sampled, it's scaled up)
  let size = vec2f(post.b.w, post.c.w);
  let uv0 = pos.xy / size;
  // FTL in or out: space bent round it, the colours a little apart at the bend
  let wp = warpAt(uv0, size);
  let uv = uv0 + wp.xy;
  var c: vec3f;
  if (post.e.x > 0.5 && dot(wp.xy, wp.xy) > 1e-10) {
    c = max(vec3f(textureSampleLevel(hdr, samp, uv0 + wp.xy * 0.94, 0.0).r, textureSampleLevel(hdr, samp, uv, 0.0).g, textureSampleLevel(hdr, samp, uv0 + wp.xy * 1.06, 0.0).b), vec3f(0.0));
  } else {
    let h0 = textureSampleLevel(hdr, samp, uv, 0.0);
    c = seaReflect(uv, max(h0.rgb, vec3f(0.0)), h0.a);
  }
  // FTL: a zoom blur toward (or away from) the point you're heading for, stronger toward the edges
  if (post.a.w > 0.0) {
    let toF = (post.b.xy - uv) * post.b.z;
    var s = c;
    for (var i = 1; i < 12; i++) {
      s += max(textureSampleLevel(hdr, samp, uv + toF * (f32(i) / 11.0) * 0.12 * post.a.w, 0.0).rgb, vec3f(0.0));
    }
    c = s / 12.0;
  }
  var seen = 1.0; // how much of the scene behind the clouds shows here
  if (post.a.x > 0.5) {
    // four bilinear taps round the pixel (a soft 4 × 4 half-res texel filter): what's left of the
    // march's jitter after the temporal blend would show as static inside the clouds
    let ct = 0.75 / vec2f(textureDimensions(clouds));
    let cl = 0.25 * (textureSampleLevel(clouds, samp, uv + vec2f(-ct.x, -ct.y), 0.0) + textureSampleLevel(clouds, samp, uv + vec2f(ct.x, -ct.y), 0.0) + textureSampleLevel(clouds, samp, uv + vec2f(-ct.x, ct.y), 0.0) + textureSampleLevel(clouds, samp, uv + vec2f(ct.x, ct.y), 0.0));
    c = max(c * cl.a + cl.rgb, vec3f(0.0)); // (the light can be negative: light shafts take haze off)
    seen = cl.a;
  }
  // bloom (it's made from the scene before the clouds: dimmed by what they let through here, or the
  // sun's glow showed through an overcast)
  c += textureSampleLevel(bloom, samp, uv, 0.0).rgb * post.a.y * seen;
  // lens flare, from the stars only (a pair's each): ghosts along the line from it through the
  // centre, as bright as the star shows in the frame right now (so a rock or a world in front dims them)
  // (z: 0 off screen, fading in from its edges)
  if (post.a.z > 0.0 && post.c.z > 0.0) { c += flare(post.c.xy, uv, size) * post.a.z * post.c.z; }
  if (post.a.z > 0.0 && post.d.z > 0.0) { c += flare(post.d.xy, uv, size) * post.a.z * post.d.z; }
  // a rainbow (docs/clouds.md): in the rain in front, the sun behind you
  if (post.bow.w > 0.0) {
    let hp = post.ivp * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
    let vd = normalize(hp.xyz / hp.w);
    let ang = degrees(acos(clamp(dot(vd, post.bow.xyz), -1.0, 1.0)));
    // (in the rain between you and the scene: little of it before something near; the sky behind
    // is all rain)
    let sd = depthAt(uv);
    let far = select(1.0, smoothstep(400.0, 4000.0, SSR_NEAR / max(sd, 1e-9)), sd > 0.0);
    if (ang < 56.0) { c = max(c + rainbow(ang) * post.bow.w * 0.18 * far, vec3f(0.0)); }
  }
  // lightning (docs/clouds.md): the bolt, a white-hot core a pixel or two across in a bluish glow,
  // hidden where the scene is nearer; and the whole view's flash
  if (post.boltK.x > 0.0) {
    c += vec3f(0.55, 0.6, 0.75) * post.boltK.z * 0.3;
    if (all(uv >= post.bolt.xy) && all(uv <= post.bolt.zw)) {
      var best = 1e9;
      var bz = 0.0;
      let n = i32(post.boltK.y);
      for (var i = 1; i < 48; i++) {
        if (i >= n) { break; }
        let a = post.boltP[i - 1];
        let b = post.boltP[i];
        if (b.w > 0.5 || a.z <= 0.0 || b.z <= 0.0) { continue; }
        let pa = (uv - a.xy) * size;
        let ba = (b.xy - a.xy) * size;
        let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        let dpx = length(pa - ba * h);
        if (dpx < best) {
          best = dpx;
          bz = mix(a.z, b.z, h);
        }
      }
      if (best < 60.0 && !(depthAt(uv) > SSR_NEAR / bz)) {
        c += vec3f(0.78, 0.84, 1.0) * (exp(-best * best / 1.6) * 6.0 + exp(-best / 7.0) * 0.6) * post.boltK.x;
      }
    }
  }
  // the warp's ring: a faint cold shimmer where space is squeezed
  c += vec3f(0.55, 0.75, 1.0) * wp.z * 0.06;
  // the shoulder (white from 0.8 up): per channel it flattened bright colours toward yellow and
  // white (a sunset's orange, red 2 : green 1, came out yellow), so up to ~3× white it's taken on
  // the brightest channel and the colour scaled with it, keeping its hue; brighter than that (the
  // sun's disc, a blaze) it goes per channel, to white
  let s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  let pc = select(c, s, c >= vec3f(0.8));
  let m = max(c.r, max(c.g, c.b));
  var hc = c;
  if (m > 0.8) { hc = c * ((0.8 + 0.2 * (1.0 - exp(-(m - 0.8) / 0.2))) / m); }
  return vec4f(mix(hc, pc, smoothstep(1.5, 4.0, m)), 1.0);
}
