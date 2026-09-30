// The Milky Way, baked once per session into a cube map (a port of render/shaders/sky.frag.glsl):
// the galactic band with its dust lanes, faint glow, and a few nebulae well off the belt. One pass
// per face; the direction comes from the face and the pixel (cube-map face conventions, texel row 0
// at the top). Written as sqrt(colour) into 8 bits so the faint band doesn't band; sky.wgsl squares
// it back.
//
// #include noise

struct Bake {
  face: u32,       // 0…5 a cube face; 6 the periscope's patch (a perspective view)
  size: f32,       // face size (px)
  pxPerRad: f32,   // resolution of what's baked (px per radian): fine layers fade in by it
  _pad: f32,
  rot: mat4x4f,    // the patch: its camera's orientation (camera → world)
  tanHalf: vec2f,  // and the tangents of its half fields of view
  px: vec2f,       // and its size (px)
}
@group(0) @binding(0) var<uniform> bake: Bake;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  // one triangle covering the viewport
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

// how visible a layer of features `freq` per radian is at this resolution: nothing until its
// features span ~6 px, fully from ~12 px
fn vis(freq: f32) -> f32 { return smoothstep(6.0, 12.0, bake.pxPerRad / freq); }

fn nebula(d: vec3f, c: vec3f, r: f32, seed: f32, outer: vec3f, inner: vec3f) -> vec3f {
  let cosd = dot(d, normalize(c));
  if (cosd < cos(r * 3.0)) { return vec3f(0.0); }
  let ang = acos(clamp(cosd, -1.0, 1.0));
  let rr = r * (0.5 + 1.0 * (fbm(d * (1.4 / r) + vec3f(seed * 5.0), 3) * 0.5 + 0.5));
  let fall = exp(-1.2 * (ang / rr) * (ang / rr));
  let p = d * (1.7 / r) + vec3f(seed);
  let w = vec3f(fbm(p * 0.35 + seed, 3), fbm(p * 0.35 + seed + 4.1, 3), fbm(p * 0.35 + seed + 8.3, 3));
  let n = fbm(p * 0.7 + w * 1.6, 6) * 0.5 + 0.5;
  let ridge = 1.0 - abs(fbm(p * 0.9 + w * 1.2 + seed * 2.0, 5));
  let fil = 0.85 * pow(clamp(n, 0.0, 1.0), 1.8) + 0.35 * pow(clamp(ridge, 0.0, 1.0), 10.0);
  let lanes = 1.0 - 0.7 * smoothstep(0.55, 0.8, fbm(p * 0.8 + w + seed * 3.1, 5) * 0.5 + 0.5);
  let core = pow(fall, 3.0) * n;
  return (outer * fall * fil * 2.4 + inner * core * 1.4) * lanes;
}

fn ringNebula(d: vec3f, c: vec3f, r: f32) -> vec3f {
  let cosd = dot(d, normalize(c));
  if (cosd < cos(r * 2.0)) { return vec3f(0.0); }
  let x = acos(clamp(cosd, -1.0, 1.0)) / r;
  let shell = exp(-pow((x - 0.75) / 0.22, 2.0)) * (0.8 + 0.4 * (fbm(d * (40.0 / r), 3) * 0.5 + 0.5));
  let fill = exp(-x * x * 2.5);
  return vec3f(0.55, 0.12, 0.18) * shell * 0.5 + vec3f(0.1, 0.35, 0.34) * fill * 0.35;
}

fn milkyWay(d: vec3f) -> vec3f {
  let gn = normalize(vec3f(0.05, 1.0, 0.12));
  let gc = normalize(vec3f(1.0, -0.05, 0.25));
  let b = dot(d, gn);
  let c = max(dot(d, gc), 0.0);
  let n1 = fbm(d * 3.0, 5) * 0.5 + 0.5;
  let n2 = fbm(d * 9.0 + 3.0, 4) * 0.5 + 0.5;
  let band = exp(-b * b / (0.012 * (1.0 + c * 3.0)));
  let wide = exp(-b * b / 0.1);
  let dust = smoothstep(0.48, 0.72, fbm(d * 7.0 + 7.0, 5) * 0.5 + 0.5) * exp(-b * b / 0.003);
  var i = band * (0.07 + 0.2 * n1 * n2) * (1.0 + 3.0 * pow(c, 3.0)) + wide * 0.025 * n1;
  i *= 1.0 - dust * 0.85;
  var det = 1.0;
  for (var k = 0; k < 5; k++) {
    let F = 160.0 * pow(4.0, f32(k));
    let v = vis(F);
    if (v <= 0.0) { break; }
    let n = snoise(d * F + f32(k) * 17.0);
    let rid = 1.0 - abs(snoise(d * F * 1.7 + f32(k) * 31.0));
    let region = smoothstep(0.45, 0.85, snoise(d * F * 0.3 + f32(k) * 7.0));
    let amp = 0.14 * pow(0.55, f32(k));
    det *= 1.0 + v * amp * n;
    i *= 1.0 + v * (amp * n - 0.2 * pow(0.6, f32(k)) * pow(clamp(rid, 0.0, 1.0), 5.0) * region * exp(-b * b / 0.008));
  }
  var col = mix(vec3f(0.55, 0.62, 0.85), vec3f(1.0, 0.84, 0.62), clamp(c * 1.2 + n2 * 0.3 - 0.2, 0.0, 1.0)) * i;
  let neb = pow(max(fbm(d * 2.4 + 11.0, 4), 0.0), 2.0);
  col += neb * vec3f(0.05, 0.012, 0.035);
  let neb2 = pow(max(fbm(d * 1.8 + 31.0, 4), 0.0), 2.0);
  col += neb2 * vec3f(0.008, 0.02, 0.04);
  let NEB_ALPHA = 0.5;
  let RING_ALPHA = 0.3;
  var neb3 = nebula(d, gn * 0.75 + vec3f(0.6, 0.0, -0.5), 0.16, 1.0, vec3f(0.62, 0.1, 0.2), vec3f(0.1, 0.42, 0.4) * 0.8);
  neb3 += nebula(d, -gn * 0.65 + vec3f(-0.5, 0.0, 0.65), 0.12, 23.0, vec3f(0.16, 0.26, 0.6), vec3f(0.35, 0.45, 0.8));
  neb3 += nebula(d, gn * 0.8 + vec3f(0.5, 0.0, 0.55), 0.1, 41.0, vec3f(0.36, 0.16, 0.55), vec3f(0.55, 0.35, 0.8));
  neb3 += nebula(d, -gn * 0.7 + vec3f(0.7, 0.0, -0.4), 0.14, 57.0, vec3f(0.12, 0.32, 0.58), vec3f(0.3, 0.55, 0.8));
  col += neb3 * NEB_ALPHA * det;
  let rings = ringNebula(d, gn * 0.9 + vec3f(-0.75, 0.0, -0.45), 0.035) + ringNebula(d, -gn * 0.9 + vec3f(-0.3, 0.0, -0.8), 0.03);
  col += rings * RING_ALPHA * det;
  return col;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var d: vec3f;
  if (bake.face == 6u) {
    // the patch: row 0 at the top
    let ndc = vec2f(pos.x / bake.px.x * 2.0 - 1.0, 1.0 - pos.y / bake.px.y * 2.0);
    d = normalize((bake.rot * vec4f(ndc * bake.tanHalf, -1.0, 0.0)).xyz);
  } else {
    d = normalize(faceDir(bake.face, pos.xy / bake.size));
  }
  return vec4f(sqrt(max(milkyWay(d), vec3f(0.0))), 1.0);
}
