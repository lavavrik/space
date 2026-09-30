// The exposure meter's image (render/exposure.ts has the why): the resolved HDR frame averaged over
// 64 × 64 px cells, each pixel weighted by its alpha, the share of it that's physical light (signal
// lights and glows write less, so the exposure ignores them). One workgroup per cell, 8 × 8 threads
// each summing an 8 × 8 block, then a reduction in workgroup memory. The CPU reads the cells back
// (asynchronously) and meters them.

@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> cells: array<vec4f>;

var<workgroup> part: array<vec3f, 64>;

@compute @workgroup_size(8, 8)
fn main(@builtin(workgroup_id) wg: vec3u, @builtin(local_invocation_id) li: vec3u, @builtin(num_workgroups) nwg: vec3u) {
  let size = vec2i(textureDimensions(hdr));
  let base = vec2i(wg.xy) * 64 + vec2i(li.xy) * 8;
  var s = vec3f(0.0);
  var n = 0.0;
  for (var y = 0; y < 8; y++) {
    for (var x = 0; x < 8; x++) {
      let p = base + vec2i(x, y);
      if (p.x >= size.x || p.y >= size.y) { continue; }
      let t = textureLoad(hdr, p, 0);
      s += t.rgb * clamp(t.a, 0.0, 1.0);
      n += 1.0;
    }
  }
  let k = li.y * 8u + li.x;
  part[k] = s / max(n, 1.0) * select(0.0, 1.0, n > 0.0);
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride >>= 1u) {
    if (k < stride) { part[k] += part[k + stride]; }
    workgroupBarrier();
  }
  if (k == 0u) {
    // (cells cut by the frame's edge average only their covered blocks; close enough for a meter)
    cells[wg.y * nwg.x + wg.x] = vec4f(min(part[0] / 64.0, vec3f(6e4)), 1.0);
  }
}
