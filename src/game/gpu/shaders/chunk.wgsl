// A terrain chunk's uniforms (bind group 2; gpu/terrain.ts writes them, render/Terrain.ts has the
// WebGL twin). The far sphere binds an empty one: the planet shader reads it either way.
struct Chunk {
  model: mat4x4f,  // chunk-local (m from the chunk's centre, the world's own axes) → camera-relative
  vOct: f32,       // octaves the vertices carry (uVOct)
  spacing: f32,    // m between vertices (uSpacing)
  skirtD: f32,     // skirt depth (m; uSkirtD)
  gridW: f32,      // vertices per grid row (N + 1)
  // the chunk centre's lattice point per octave (terrain.wgsl terrQ): noise (wrapped by 8) and the
  // crater hash (wrapped by 2312), so the shader adds only small offsets to them
  qn: array<vec4f, 17>,
  qc: array<vec4f, 17>,
}
@group(2) @binding(0) var<uniform> chunk: Chunk;
