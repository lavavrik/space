// Fast fBm for the planet shaders (render/shaders/noise3d.glsl): exact simplex noise for the first
// FBM_EXACT octaves, the tileable 3D noise texture (lib/noise3d.ts, 64³ r8, 8 cells) for finer ones.
const FBM_EXACT: i32 = 3;

fn tnoise(p: vec3f) -> f32 {
  return textureSampleLevel(noiseTex, noiseSamp, p * 0.125, 0.0).r * 2.0 - 1.0;
}

// GLSL's mod (always toward −∞), which WGSL's % isn't for negative values
fn gmod3(x: vec3f, y: f32) -> vec3f { return x - y * floor(x / y); }

// the same, filtered here at full precision (the GPU's filter weights have only 8 bits)
fn tnoiseHQ(p: vec3f) -> f32 {
  let x = p * 8.0 - 0.5;
  let i0 = floor(x);
  let f = x - i0;
  let a = vec3i(gmod3(i0, 64.0));
  let b = vec3i(gmod3(i0 + 1.0, 64.0));
  let c000 = textureLoad(noiseTex, vec3i(a.x, a.y, a.z), 0).r;
  let c100 = textureLoad(noiseTex, vec3i(b.x, a.y, a.z), 0).r;
  let c010 = textureLoad(noiseTex, vec3i(a.x, b.y, a.z), 0).r;
  let c110 = textureLoad(noiseTex, vec3i(b.x, b.y, a.z), 0).r;
  let c001 = textureLoad(noiseTex, vec3i(a.x, a.y, b.z), 0).r;
  let c101 = textureLoad(noiseTex, vec3i(b.x, a.y, b.z), 0).r;
  let c011 = textureLoad(noiseTex, vec3i(a.x, b.y, b.z), 0).r;
  let c111 = textureLoad(noiseTex, vec3i(b.x, b.y, b.z), 0).r;
  let c = mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y), mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z);
  return c * 2.0 - 1.0;
}

fn fbmF(p0: vec3f, oct: i32) -> f32 {
  var a = 0.5;
  var s = 0.0;
  var p = p0;
  for (var i = 0; i < oct; i++) {
    // (not select(): it evaluates both)
    if (i < FBM_EXACT) { s += a * snoise(p); } else { s += a * tnoise(p); }
    p = p * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
}
