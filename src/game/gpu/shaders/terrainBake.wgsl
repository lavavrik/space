// A terrain chunk's bake (render/shaders/planet.vert.glsl TERRAIN_BAKE, there a points pass into a
// float texture): one invocation per grid vertex, writing two vec4s into the chunk's storage buffer
//   bake[2i]     normal.xyz (the world's frame), elevation (m)
//   bake[2i + 1] sun (1 lit, 0 in a mountain's shadow), h with the chunk's octaves, range mask,
//                a pair's second sun likewise (docs/binaries.md; 0 with one star)
//   bake[2i + 2] the large-scale colour terms: moisture's two big octaves, the colour patches' base (terrain.wgsl)
// which the drawing pass (planet.wgsl vsChunk) just reads. Run when a chunk is made and again when
// the sun has moved over it (gpu/terrain.ts).
// #include world
// #include chunk
// #include noise
// #include noise3d
// #include terrain

@group(2) @binding(1) var<storage, read_write> bake: array<vec4f>;
@group(2) @binding(2) var<storage, read> vpos: array<f32>; // the chunk's vertices (m from its centre)
@group(2) @binding(3) var<storage, read> vdir: array<f32>; // and their unit directions

fn seaOn() -> bool { return world.wtype == 2 || world.wtype == 3; }
fn elevAt(d: vec3f, vo: i32) -> f32 { return terrElev(terrH(d, vo, vo), world.sea, seaOn()); }
// the same at the vertex's direction plus a small precise offset (terrQ)
fn elevOff(d: vec3f, off: vec3f, vo: i32) -> f32 {
  tUseOff = true;
  tOffDir = off;
  let e = elevAt(d, vo);
  tUseOff = false;
  return e;
}

const SHADOW_STEPS: i32 = 12;
const SHADOW_OCT: i32 = 9; // mountains and big craters cast shadows; finer relief only shades itself
// March from P (the world's frame, m from its centre) toward the sun L, steps growing geometrically
// from two vertex spacings to 60 relief amplitudes, stopping once above the highest terrain; the
// soft edge from how closely the ray passes over the ground (as the GLSL).
fn sunShadow(P: vec3f, L: vec3f, vo: i32) -> f32 {
  let so = min(vo, SHADOW_OCT);
  let t0 = chunk.spacing * 2.0;
  let tMax = 60.0 * world.terrA;
  let g = pow(tMax / t0, 1.0 / f32(SHADOW_STEPS - 1));
  let top = world.radius + 2.6 * world.terrA;
  var lit = 1.0;
  var t = t0;
  for (var k = 0; k < SHADOW_STEPS; k++) {
    let Q = P + L * t;
    let rq = length(Q);
    if (rq > top && dot(Q, L) > 0.0) { break; }
    let clear = rq - world.radius - elevAt(Q / rq, so) + chunk.spacing * 0.3;
    lit = min(lit, 12.0 * clear / t);
    if (lit <= 0.0) { break; }
    t *= g;
  }
  return clamp(lit, 0.0, 1.0);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(chunk.gridW + 0.5);
  let i = id.x;
  if (i >= n * n) { return; }
  tExact = (u32(world._pq) & 8388608u) == 0u; // (the noise exactly: no texel grid in the mesh; tdbg 8388608: as before)
  let dir = vec3f(vdir[3u * i], vdir[3u * i + 1u], vdir[3u * i + 2u]);
  let position = vec3f(vpos[3u * i], vpos[3u * i + 1u], vpos[3u * i + 2u]);
  let vo = i32(chunk.vOct + 0.5);
  let off = position / world.radius; // the point's direction minus the chunk centre's
  tUseOff = true;
  tOffDir = off;
  let h = terrH(dir, vo, vo);
  tUseOff = false;
  let mask = tMask;
  let e = terrElev(h, world.sea, seaOn());
  // normal from the slope: two samples a vertex spacing away along the surface
  var up = vec3f(1.0, 0.0, 0.0);
  if (abs(dir.y) < 0.99) { up = vec3f(0.0, 1.0, 0.0); }
  let t1 = normalize(cross(dir, up));
  let t2 = cross(dir, t1);
  let eps = chunk.spacing / world.radius;
  let e1 = elevOff(normalize(dir + t1 * eps), off + t1 * eps, vo);
  let e2 = elevOff(normalize(dir + t2 * eps), off + t2 * eps, vo);
  bake[3u * i + 2u] = vec4f(moist12(dir, world.seed), h2Base(dir, world.seed), 0.0, 0.0);
  bake[3u * i] = vec4f(normalize(dir - t1 * ((e1 - e) / chunk.spacing) - t2 * ((e2 - e) / chunk.spacing)), e);
  let L = world.lightL.xyz;
  var sun = 0.0; // night side: dark anyway
  if (dot(dir, L) >= -0.2) { sun = sunShadow(dir * (world.radius + e), L, vo); }
  var sun2 = 0.0;
  let L2 = world.lightL2.xyz;
  if (world.light2.w > 0.5 && dot(dir, L2) >= -0.2) { sun2 = sunShadow(dir * (world.radius + e), L2, vo); }
  bake[3u * i + 1u] = vec4f(sun, h, mask, sun2);
}
