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

// The texture's noise exactly, smooth (lib/noise3d.ts gnoise): its gradient noise from the lattice's
// gradients, quintic between them, at tnoise's coordinates (its half-texel offset included). The
// texture's linear filter puts a kink in the slope at every texel face, axis-aligned planes that
// crossed the terrain as straight lines, a grid of odd-shaped cells seen from any height. 8 reads
// (as tnoiseHQ's), on a texture of 8 KB.
fn gnoise(p: vec3f) -> f32 {
  let x = p - vec3f(0.0625);
  let i0 = floor(x);
  let f = x - i0;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = vec3i(gmod3(i0, 8.0));
  let b = vec3i(gmod3(i0 + 1.0, 8.0));
  let n000 = dot(textureLoad(gradTex, vec3i(a.x, a.y, a.z), 0).xyz, f);
  let n100 = dot(textureLoad(gradTex, vec3i(b.x, a.y, a.z), 0).xyz, f - vec3f(1.0, 0.0, 0.0));
  let n010 = dot(textureLoad(gradTex, vec3i(a.x, b.y, a.z), 0).xyz, f - vec3f(0.0, 1.0, 0.0));
  let n110 = dot(textureLoad(gradTex, vec3i(b.x, b.y, a.z), 0).xyz, f - vec3f(1.0, 1.0, 0.0));
  let n001 = dot(textureLoad(gradTex, vec3i(a.x, a.y, b.z), 0).xyz, f - vec3f(0.0, 0.0, 1.0));
  let n101 = dot(textureLoad(gradTex, vec3i(b.x, a.y, b.z), 0).xyz, f - vec3f(1.0, 0.0, 1.0));
  let n011 = dot(textureLoad(gradTex, vec3i(a.x, b.y, b.z), 0).xyz, f - vec3f(0.0, 1.0, 1.0));
  let n111 = dot(textureLoad(gradTex, vec3i(b.x, b.y, b.z), 0).xyz, f - vec3f(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}

// fbmF's octaves from o0 on only (the first ones come baked: terrainBake.wgsl)
fn fbmFrom(p0: vec3f, o0: i32, oct: i32) -> f32 {
  var a = 0.5;
  var s = 0.0;
  var p = p0;
  for (var i = 0; i < oct; i++) {
    if (i >= o0) {
      if (i < FBM_EXACT) { s += a * snoise(p); } else { s += a * tnoise(p); }
    }
    p = p * 2.03 + vec3f(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s;
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
