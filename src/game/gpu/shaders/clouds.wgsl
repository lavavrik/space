// Cloud cover (render/shaders/clouds.glsl): cloudRaw is what the per-world bake evaluates (into a
// cube map in the world's own frame), cloudCover turns a raw value into cover (0…1).
fn cloudRaw(p: vec3f, oct: i32) -> f32 {
  let s = world.seed;
  let cp = (p * 1.6 + vec3f(s * 1.7, s * 2.3, s * 0.9)) * 1.25;
  return fbmF(cp + fbmF(cp * 2.0, 4) * 0.7, oct);
}
// Earth-like and ocean worlds (wtype 2, 3) are clouded over most of their face, with clear
// stretches between weather systems (at the others' threshold, from 0.02, about half their face was
// bare, and the volumetric clouds' own gaps, vclouds.wgsl, left most of the rest clear too)
fn cloudCover(raw: f32) -> f32 {
  let wet = world.wtype == 2 || world.wtype == 3;
  return smoothstep(select(0.02, -0.2, wet), select(0.5, 0.25, wet), raw) * select(0.85, 0.95, world.wtype == 3);
}
