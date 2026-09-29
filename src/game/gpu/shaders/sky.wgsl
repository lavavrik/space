// The Milky Way behind everything: the baked cube map (skyBake.wgsl) looked up along each pixel's
// direction, squared back from the sqrt it was stored as. (render/shaders/skyCube.frag.glsl; the
// periscope's sharper patch comes later.)
//
// #include frame

@group(1) @binding(0) var skyTex: texture_cube<f32>;
@group(1) @binding(1) var skySamp: sampler;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return fullscreen(i);
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let c = textureSample(skyTex, skySamp, viewDir(pos.xy)).rgb;
  return vec4f(c * c * frame.skyExp, 1.0);
}
