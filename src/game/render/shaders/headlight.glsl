// The ship's headlights: a floodlight cone from the ship (the camera, at the origin of these
// camera-relative positions) along its nose. Lights whatever it hits out to a kilometre or two.
uniform vec3 uHeadDir; // ship's nose, world axes
uniform float uHeadOn; // 0 or 1
vec3 headlight(vec3 N, vec3 wp, vec3 albedo){
  float d = length(wp);
  vec3 toSurf = wp / max(d, 1e-3);
  float cone = smoothstep(0.88, 0.97, dot(toSurf, uHeadDir));      // ~14–28° half-angle, soft edge
  float fall = 1.0 / (1.0 + (d / 500.0) * (d / 500.0));             // inverse square beyond ~500 m
  float ndl = max(dot(N, -toSurf), 0.0);
  return albedo * vec3(1.0, 0.96, 0.88) * cone * fall * ndl * uHeadOn * 1.8;
}
