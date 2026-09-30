// The HDR frame to the screen (render/hdr.ts TONE_FS): the volumetric clouds laid over it first
// (vclouds.wgsl: scene × what they let through + their light, upsampled from half resolution), then
// linear up to 0.8 and a soft shoulder toward 1 per channel, so over-bright light rolls off to white
// instead of clipping flat. Written as is to the canvas: the game's colours are display values.

@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var clouds: texture_2d<f32>;
@group(0) @binding(2) var cloudSamp: sampler;
@group(0) @binding(3) var<uniform> tone: vec4f; // x: clouds on

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = max(textureLoad(hdr, vec2i(pos.xy), 0).rgb, vec3f(0.0));
  if (tone.x > 0.5) {
    let cl = textureSampleLevel(clouds, cloudSamp, pos.xy / vec2f(textureDimensions(hdr)), 0.0);
    c = c * cl.a + max(cl.rgb, vec3f(0.0));
  }
  let s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  return vec4f(select(c, s, c >= vec3f(0.8)), 1.0);
}
