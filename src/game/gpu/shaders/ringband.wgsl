// A ring's opacity at radius r (planet radii): bands of noise across it, soft edges, a Cassini-like
// gap at 63 % (ring.wgsl draws it; shadow.wgsl casts it onto the planet).
fn ringAlpha(r: f32, inner: f32, outer: f32, seed: f32) -> f32 {
  let t = (r - inner) / (outer - inner);
  if (t <= 0.0 || t >= 1.0) { return 0.0; }
  let band = 0.55 + 0.35 * snoise(vec3f(r * 14.0, seed, 0.0)) + 0.25 * snoise(vec3f(r * 60.0, seed, 1.0));
  var alpha = smoothstep(0.0, 0.06, t) * (1.0 - smoothstep(0.86, 1.0, t)) * clamp(band, 0.0, 1.0) * 0.85;
  alpha *= smoothstep(0.015, 0.04, abs(t - 0.63));
  return alpha;
}
