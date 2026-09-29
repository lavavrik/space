// The HDR frame to the screen (render/hdr.ts TONE_FS): linear up to 0.8, then a soft shoulder toward
// 1 per channel, so over-bright light rolls off to white instead of clipping flat. Written as is to
// the canvas: the game's colours are display values already (as in the WebGL renderer).

@group(0) @binding(0) var hdr: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = max(textureLoad(hdr, vec2i(pos.xy), 0).rgb, vec3f(0.0));
  let s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return vec4f(select(c, s, c >= vec3f(0.8)), 1.0);
}
