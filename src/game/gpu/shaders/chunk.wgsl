// A terrain chunk's uniforms (bind group 2; gpu/terrain.ts writes them). The far sphere binds an empty one: the planet shader reads it either way.
struct Chunk {
  // x: its slot in `chunkModels` (the rest unused). Its transform, chunk-local (m from the chunk's
  // centre, the world's own axes) → camera-relative, changes every frame; all of a world's go up in
  // one write (gpu/terrain.ts): a write per chunk, ~1,100 a frame landed, cost more in the driver
  // (D3D12 on Windows) than the frame's whole GPU work
  slot: vec4f,
  _m: array<vec4f, 3>,
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
@group(2) @binding(4) var<storage, read> chunkModels: array<mat4x4f>;
fn chunkModel() -> mat4x4f { return chunkModels[u32(chunk.slot.x + 0.5)]; }
