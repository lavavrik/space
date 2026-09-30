// Shadows cast across a world (docs/shadows.md), both analytic, so they're exact at any distance:
//   - eclipse: the share of the star's disc a point sees past the bodies that can shadow this world
//     (world.occ; sim/eclipse.ts picks them and runs the same formula for the solar panels), with the
//     penumbra from the star's size;
//   - ringShade: its ring's shadow, from where the sun's ray crosses the ring plane and the ring's
//     opacity there (ringband.wgsl).
// Needs world, noise and ringband.

// share of a star (angular radius aS) covered by a disc of aO at separation sep (rad)
fn discCover(aS: f32, aO: f32, sep: f32) -> f32 {
  let full = min(1.0, (aO / aS) * (aO / aS));
  let t = clamp((aS + aO - sep) / max(aS + aO - abs(aO - aS), 1e-12), 0.0, 1.0);
  return full * t * t * (3.0 - 2.0 * t);
}

// P: the point relative to the world's centre (m, world axes)
fn eclipse(P: vec3f) -> f32 {
  let S = world.sunC.xyz - P;
  let dS = length(S);
  let Ld = S / dS;
  let aS = asin(min(1.0, world.sunC.w / dS));
  var lit = 1.0;
  let n = i32(world.ringP.w + 0.5);
  for (var i = 0; i < 4; i++) {
    if (i >= n) { break; }
    let O = world.occ[i].xyz - P;
    let along = dot(O, Ld);
    if (along <= 0.0) { continue; }
    let dO = length(O);
    let r = world.occ[i].w;
    if (dO <= r) { continue; }
    let aO = asin(min(1.0, r / dO));
    let sep = acos(clamp(along / dO, -1.0, 1.0));
    if (sep >= aS + aO) { continue; }
    lit *= 1.0 - discCover(aS, aO, sep);
  }
  return lit;
}

// Pl: the point in the world's own frame (m from its centre; the ring lies in its y = 0 plane),
// Ll: the direction to the star in that frame
fn ringShade(Pl: vec3f, Ll: vec3f) -> f32 {
  if (world.ringP.y <= 0.0 || abs(Ll.y) < 1e-5) { return 1.0; }
  let t = -Pl.y / Ll.y;
  if (t <= 0.0) { return 1.0; }
  let h = Pl + Ll * t;
  let r = length(h.xz) / world.radius;
  return 1.0 - 0.9 * ringAlpha(r, world.ringP.x, world.ringP.y, world.ringP.z);
}

fn toLocalM() -> mat3x3f { return mat3x3f(world.toLocal[0].xyz, world.toLocal[1].xyz, world.toLocal[2].xyz); }

// both, for a point relative to the world's centre in world axes
fn sunShade(P: vec3f) -> f32 {
  return eclipse(P) * ringShade(toLocalM() * P, world.lightL.xyz);
}
