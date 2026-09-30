// Bloom (gpu/post.ts; docs/post.md): the bright parts of the frame, blurred wide through a chain of
// half-size copies. Down: a 13-tap filter (Jimenez, "Next Generation Post Processing in Call of Duty:
// AW"), the first one keeping only light over the threshold (with a soft knee, and each tap group
// weighted down by its brightness so single hot pixels don't flicker). Up: a 3 × 3 tent, added into
// the next larger copy, weighted down (post.ts UP_W) so a wide bright area doesn't glow far out. The post pass adds the largest to the frame.

struct BloomP {
  texel: vec2f,     // the source's texel (uv)
  threshold: f32,   // down: light under this doesn't bloom (display units); up: the coarser level's weight
  first: f32,       // 1: the first downsample (the threshold and the fireflies' weighting apply)
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> bp: BloomP;

struct V {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs(@builtin(vertex_index) i: u32) -> V {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: V;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}

// (anything not a finite, non-negative number taken as black: one NaN pixel, from any shader, was
// spread by the low mips into a black block a fifth of the screen across)
fn tap(uv: vec2f) -> vec3f {
  let c = textureSampleLevel(src, samp, uv, 0.0).rgb;
  return select(vec3f(0.0), c, (c >= vec3f(0.0)) & (c < vec3f(1e30)));
}

// the part over the threshold, with a soft knee
fn over(c: vec3f) -> vec3f {
  let b = max(c.r, max(c.g, c.b));
  let knee = bp.threshold * 0.5;
  var soft = clamp(b - bp.threshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-5);
  return c * max(soft, b - bp.threshold) / max(b, 1e-5);
}
fn karis(c: vec3f) -> f32 { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }

@fragment
fn fsDown(in: V) -> @location(0) vec4f {
  let t = bp.texel;
  let uv = in.uv;
  let a = tap(uv + t * vec2f(-2.0, -2.0));
  let b = tap(uv + t * vec2f(0.0, -2.0));
  let c = tap(uv + t * vec2f(2.0, -2.0));
  let d = tap(uv + t * vec2f(-1.0, -1.0));
  let e = tap(uv + t * vec2f(1.0, -1.0));
  let f = tap(uv + t * vec2f(-2.0, 0.0));
  let g = tap(uv);
  let h = tap(uv + t * vec2f(2.0, 0.0));
  let i = tap(uv + t * vec2f(-1.0, 1.0));
  let j = tap(uv + t * vec2f(1.0, 1.0));
  let k = tap(uv + t * vec2f(-2.0, 2.0));
  let l = tap(uv + t * vec2f(0.0, 2.0));
  let m = tap(uv + t * vec2f(2.0, 2.0));
  if (bp.first > 0.5) {
    // five overlapping boxes, each thresholded and weighted by its brightness
    let g0 = over((d + e + i + j) * 0.25);
    let g1 = over((a + b + f + g) * 0.25);
    let g2 = over((b + c + g + h) * 0.25);
    let g3 = over((f + g + k + l) * 0.25);
    let g4 = over((g + h + l + m) * 0.25);
    let w0 = karis(g0) * 0.5;
    let w1 = karis(g1) * 0.125;
    let w2 = karis(g2) * 0.125;
    let w3 = karis(g3) * 0.125;
    let w4 = karis(g4) * 0.125;
    return vec4f((g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4), 1.0);
  }
  let o = (d + e + i + j) * 0.125 + (a + b + f + g + b + c + g + h + f + g + k + l + g + h + l + m) * 0.03125;
  return vec4f(o, 1.0);
}

@fragment
fn fsUp(in: V) -> @location(0) vec4f {
  let t = bp.texel;
  let uv = in.uv;
  var s = tap(uv) * 4.0;
  s += (tap(uv + vec2f(-t.x, 0.0)) + tap(uv + vec2f(t.x, 0.0)) + tap(uv + vec2f(0.0, -t.y)) + tap(uv + vec2f(0.0, t.y))) * 2.0;
  s += tap(uv + vec2f(-t.x, -t.y)) + tap(uv + vec2f(t.x, -t.y)) + tap(uv + vec2f(-t.x, t.y)) + tap(uv + vec2f(t.x, t.y));
  return vec4f(s / 16.0 * bp.threshold, 1.0);
}
