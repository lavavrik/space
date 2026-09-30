// A world's uniforms and textures (bind group 1), shared by its surface, sky shell, cloud layer and
// cloud bake (gpu/worlds.ts writes them; the WebGL renderer's uniforms of the same names in comments).
// WGSL has no `out` parameters or mutable globals across calls by reference, so the GLSL's are
// module-scope `var<private>` here (tDet, tMask, …).

struct World {
  model: mat4x4f,     // unit sphere → camera-relative world: position, tilt × spin, radius
  rotN: mat4x4f,      // the same rotation only (normals)
  toLocal: mat4x4f,   // world axes → the world's own frame (uToLocal; upper 3×3)
  pa: vec4f,          // palette a…d (uA…uD)
  pb: vec4f,
  pc: vec4f,
  pd: vec4f,
  atmoCol: vec4f,     // uAtmo, w: uAtmoK (worlds without air: the rim glow)
  light: vec4f,       // direction to the star (uLight)
  lightL: vec4f,      // the same in the world's own frame (uLightL)
  atC: vec4f,         // the world's centre, camera-relative (uAtC); w: mean radius (uAtR)
  atBeta: vec4f,      // scattering at the mean radius (uAtBeta); w: scale height (uAtH)
  atTop: f32,         // radius where the air ends (uAtTop)
  atSunI: f32,        // sunlight's strength (uAtSunI)
  atOn: f32,          // 1 with air (uAtOn)
  sea: f32,           // uSea
  seed: f32,
  time: f32,
  camAlt: f32,
  cloudH: f32,        // cloud deck height (m), 0: none
  radius: f32,
  craters: f32,
  terrA: f32,         // relief amplitude (m)
  _pq: f32,
  city: f32,          // 1: populated (uCity)
  cityK: f32,
  cloudR: f32,        // the cloud layer's radius (m)
  wtype: i32,         // world type (uType)
  oct: i32,           // octaves for this size on screen (uOct)
  deckHide: f32,      // 0…1: the flat cloud deck fades out as the volumetric clouds take over (vclouds.wgsl)
  _p1: f32,
  _p2: f32,
  tOff: array<vec4f, 17>, // per-octave noise offsets (terrain.wgsl)
  // shadows (shadow.wgsl): the star relative to the world's centre (world axes; w: its radius), the
  // bodies that can eclipse it (centre likewise; w: radius), its ring (inner, outer radius in planet
  // radii, seed; w: how many of occ are set)
  sunC: vec4f,
  occ: array<vec4f, 4>,
  ringP: vec4f,
}

@group(1) @binding(0) var<uniform> world: World;
@group(1) @binding(1) var noiseTex: texture_3d<f32>;
@group(1) @binding(2) var noiseSamp: sampler;
@group(1) @binding(3) var cloudTex: texture_cube<f32>;
@group(1) @binding(4) var cloudSamp: sampler;

// smoothstep for either order of edges (GLSL's allows e0 > e1; WGSL leaves it undefined)
fn sm(a: f32, b: f32, x: f32) -> f32 {
  let t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
