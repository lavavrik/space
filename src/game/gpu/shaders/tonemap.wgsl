// The final pass to the screen (gpu/post.ts; docs/post.md): the frame, blurred toward where you're
// heading in FTL; the volumetric clouds laid over it (vclouds.wgsl: scene × what they let through +
// their light, upsampled); bloom (bloom.wgsl) and the star's lens-flare ghosts; then linear up to 0.8 and a soft shoulder toward 1 per channel, so over-bright light rolls
// off to white instead of clipping flat. Written as is to the canvas: the colours are display values.

struct Post {
  a: vec4f, // clouds on, bloom strength, flare strength, blur strength
  b: vec4f, // the screen point you're heading for (uv), whether it's in front (1) or behind (−1); w: the canvas's width (px)
  c: vec4f, // the star on screen (uv); z: 1 if it's in front; w: the canvas's height (px)
  d: vec4f, // a pair's other star likewise (docs/binaries.md); z: 0 with one star
  e: vec4f, // x: how many warps are set
  // FTL entries and exits (gpu/post.ts warpsOf): the warp's centre (uv), its size (screen heights)
  // and its age (0…1)
  warps: array<vec4f, 8>,
}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var clouds: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;
@group(0) @binding(4) var bloom: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

// a star's lens-flare ghosts at `uv`, for the star at `sp` on screen
fn flare(sp: vec2f, uv: vec2f, size: vec2f) -> vec3f {
  // (behind clouds: as much of it as they let through)
  let through = select(1.0, textureSampleLevel(clouds, samp, sp, 0.0).a, post.a.x > 0.5);
  let src = max(textureSampleLevel(hdr, samp, sp, 0.0).rgb - vec3f(0.8), vec3f(0.0)) * 0.6 * through;
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
  for (var i = 0; i < 8; i++) {
    if (i >= n) { break; }
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
    c = max(textureSampleLevel(hdr, samp, uv, 0.0).rgb, vec3f(0.0));
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
  if (post.a.z > 0.0 && post.c.z > 0.5) { c += flare(post.c.xy, uv, size) * post.a.z; }
  if (post.a.z > 0.0 && post.d.z > 0.5) { c += flare(post.d.xy, uv, size) * post.a.z; }
  // the warp's ring: a faint cold shimmer where space is squeezed
  c += vec3f(0.55, 0.75, 1.0) * wp.z * 0.06;
  let s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return vec4f(select(c, s, c >= vec3f(0.8)), 1.0);
}
