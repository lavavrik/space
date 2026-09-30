// A world's cloud pattern baked into a cube map in its own frame (render/shaders/cloudBake.frag.glsl):
// each texel the raw cloud value (clouds.wgsl) in its direction, and the ground's coarse height
// there (m over the sea), which lifts the clouds over high ground (clouds.wgsl cloudLiftAt). 8
// octaves (features ~90 km and up): the ranges, not each ridge (with 11 the cloud tops were
// corrugated along the ridges); cloudLiftAt's margin covers the peaks. One pass per face, as
// skyBake.wgsl.
// #include world
// #include chunk
// #include noise
// #include noise3d
// #include terrain
// #include clouds

struct Bake {
  face: u32,
  size: f32,
  _p0: f32,
  _p1: f32,
}
@group(0) @binding(0) var<uniform> bake: Bake;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn faceDir(face: u32, st: vec2f) -> vec3f {
  let sc = st.x * 2.0 - 1.0;
  let tc = st.y * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3f(1.0, -tc, -sc); }
    case 1u: { return vec3f(-1.0, -tc, sc); }
    case 2u: { return vec3f(sc, 1.0, tc); }
    case 3u: { return vec3f(sc, -1.0, -tc); }
    case 4u: { return vec3f(sc, -tc, 1.0); }
    default: { return vec3f(-sc, -tc, -1.0); }
  }
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let d = normalize(faceDir(bake.face, pos.xy / bake.size));
  let wet = world.wtype == 2 || world.wtype == 3;
  let ground = select(0.0, terrElev(terrH(d, 8, 8), world.sea, wet), world.terrA > 0.0);
  return vec4f(cloudRaw(d, 7), ground, 0.0, 1.0);
}
