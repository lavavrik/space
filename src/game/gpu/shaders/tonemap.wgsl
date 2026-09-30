// The final pass to the screen (gpu/post.ts; docs/post.md): the frame, blurred toward where you're
// heading in FTL; the volumetric clouds laid over it (vclouds.wgsl: scene × what they let through +
// their light, upsampled); bloom (bloom.wgsl) and a lens flare's ghosts from the brightest
// points; then linear up to 0.8 and a soft shoulder toward 1 per channel, so over-bright light rolls
// off to white instead of clipping flat. Written as is to the canvas: the colours are display values.

struct Post {
  a: vec4f, // clouds on, bloom strength, flare strength, blur strength
  b: vec4f, // the screen point you're heading for (uv), and whether it's in front (1) or behind (−1)
}
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var clouds: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;
@group(0) @binding(4) var bloom: texture_2d<f32>;
@group(0) @binding(5) var bloomSmall: texture_2d<f32>;

// what makes flares: only the brightest of the bloom (the star, lamps), not a whole lit planet
fn flareSrc(uv: vec2f) -> vec3f { return max(textureSampleLevel(bloomSmall, samp, uv, 0.0).rgb - vec3f(1.0), vec3f(0.0)); }

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(hdr));
  let uv = pos.xy / size;
  var c = max(textureLoad(hdr, vec2i(pos.xy), 0).rgb, vec3f(0.0));
  // FTL: a zoom blur toward (or away from) the point you're heading for, stronger toward the edges
  if (post.a.w > 0.0) {
    let toF = (post.b.xy - uv) * post.b.z;
    var s = c;
    for (var i = 1; i < 12; i++) {
      s += max(textureSampleLevel(hdr, samp, uv + toF * (f32(i) / 11.0) * 0.12 * post.a.w, 0.0).rgb, vec3f(0.0));
    }
    c = s / 12.0;
  }
  if (post.a.x > 0.5) {
    let cl = textureSampleLevel(clouds, samp, uv, 0.0);
    c = max(c * cl.a + cl.rgb, vec3f(0.0)); // (the light can be negative: light shafts take haze off)
  }
  // bloom
  c += textureSampleLevel(bloom, samp, uv, 0.0).rgb * post.a.y;
  // lens flare: small ghosts of the brightest points mirrored through the centre (no halo: from a bright
  // limb or sky it swept arcs across the whole view)
  if (post.a.z > 0.0) {
    let m = vec2f(1.0) - uv;
    let gv = (vec2f(0.5) - m) * 0.4;
    var fl = vec3f(0.0);
    let tint = array<vec3f, 4>(vec3f(1.0, 0.8, 0.6), vec3f(0.6, 0.9, 1.0), vec3f(0.9, 0.6, 1.0), vec3f(0.7, 1.0, 0.7));
    for (var i = 1; i < 5; i++) {
      let o = fract(m + gv * f32(i));
      let w = pow(max(0.0, 1.0 - length(vec2f(0.5) - o) / 0.7071), 5.0);
      fl += flareSrc(o) * w * tint[i - 1];
    }
    c += fl * post.a.z;
  }
  let s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return vec4f(select(c, s, c >= vec3f(0.8)), 1.0);
}
