// Cloud cover (render/shaders/clouds.glsl): cloudRaw is what the per-world bake evaluates (into a
// cube map in the world's own frame), cloudCover turns a raw value into cover (0…1).
fn cloudRaw(p: vec3f, oct: i32) -> f32 {
  let s = world.seed;
  let cp = (p * 1.6 + vec3f(s * 1.7, s * 2.3, s * 0.9)) * 1.25;
  return fbmF(cp + fbmF(cp * 2.0, 4) * 0.7, oct);
}
fn cloudCover(raw: f32) -> f32 { return smoothstep(0.02, 0.5, raw) * select(0.85, 0.95, world.wtype == 3); }
