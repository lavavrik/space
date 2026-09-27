// The ship's headlights, as a physical lamp: a cone along the nose (the camera sits at the origin of
// these camera-relative positions) with inverse-square falloff. `K` turns candela into this
// shader's brightness at the current exposure (render/exposure.ts), so the same lamp is invisible
// next to sunlight and plainly visible in a station's shadow or hangar.
uniform vec3 uHeadDir; // ship's nose, world axes
uniform float uHeadOn; // 0 or 1
vec3 headlight(vec3 N, vec3 wp, vec3 albedo, float K){
  float d = max(length(wp), 5.0);
  vec3 toSurf = wp / d;
  float cone = smoothstep(0.91, 0.96, dot(toSurf, uHeadDir));   // ~16–24° half-angle, soft edge
  float ndl = max(dot(N, -toSurf), 0.0);
  return albedo * vec3(1.0, 0.96, 0.88) * cone * ndl * uHeadOn * K / (d * d);
}
