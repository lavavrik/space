// Grain fields (gpu/particles.ts; docs/particles.md): many still specks made up in the vertex
// stage from their index, no buffers. A draw's instances are one field's grains: its index in the
// top bits of the instance index (firstInstance = field << 20), the grain in the rest.
//   - wrap: grains hashed into a box of the given size that repeats through space, placed round the
//     camera by where it is in that space (`anchor`: the camera's position there, wrapped by the CPU,
//     in doubles), fading toward the box's edge: space dust, ring dust. They stay put as you move.
//   - ball: grains in a ball round a point (camera-relative), each tumbling so it glints now and then:
//     a wreck's debris.
// #include frame
// #include sprite

struct Field {
  anchor: vec4f,  // wrap: the camera's place in the repeating space, wrapped (m); ball: its centre, camera-relative; w: mode (0 wrap, 1 ball)
  p: vec4f,       // box size or ball radius (m), grains, seed, size (m; negative: pixels)
  col: vec4f,     // rgb; w: glint strength
  sun: vec4f,     // direction to the star (glints); w: time (s)
}
struct Fields {
  f: array<Field, 8>,
}
@group(1) @binding(0) var<uniform> fields: Fields;

fn hash3(i: u32, seed: u32) -> vec3f {
  var s = i * 747796405u + seed * 2891336453u + 1u;
  var o = vec3f(0.0);
  for (var k = 0; k < 3; k++) {
    s = s * 747796405u + 2891336453u;
    let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
    o[k] = f32((w >> 22u) ^ w) / 4294967295.0;
  }
  return o;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let f = fields.f[ii >> 20u];
  let i = ii & 0xfffffu;
  let seed = u32(f.p.z);
  let h = hash3(i, seed);
  var c: vec3f;
  var fade = 1.0;
  if (f.anchor.w < 0.5) {
    let box = f.p.x;
    let q = h * box - f.anchor.xyz + 0.5 * box;
    c = q - box * floor(q / box) - 0.5 * box; // (the nearest copy of the grain)
    fade = max(0.0, 1.0 - length(c) / (0.5 * box));
  } else {
    let u = hash3(i, seed + 7u);
    let z = u.x * 2.0 - 1.0;
    let a = u.y * 6.2831853;
    let rr = sqrt(max(0.0, 1.0 - z * z));
    c = f.anchor.xyz + vec3f(rr * cos(a), rr * sin(a), z) * pow(h.x, 0.5) * f.p.x;
  }
  // a glint now and then: each grain turns at its own rate, flashing when a facet catches the sun
  let spin = sin(f.sun.w * (0.5 + 2.0 * h.y) + h.z * 40.0);
  let glint = 1.0 + f.col.w * pow(max(spin, 0.0), 40.0);
  // fine grains scatter mostly forward: backlit by the star, dust glows
  let fwdK = 1.0 + 5.0 * pow(max(dot(normalize(c), f.sun.xyz), 0.0), 6.0);
  var size = f.p.w;
  if (size < 0.0) { size = -size * length(c) / (frame.proj.y * frame.viewport.y * 0.5); } // pixels → metres there
  return sprite(vi, c, vec3f(0.0), size, f.col.rgb * fade * glint * fwdK * (0.6 + 0.8 * h.y));
}

@fragment
fn fs(in: SpriteOut) -> @location(0) vec4f {
  return spriteLight(in);
}
