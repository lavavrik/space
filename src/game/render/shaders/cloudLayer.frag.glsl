// The cloud layer (docs/atmosphere.md): a shell at the cloud deck's height, seen from above or
// below. Each pixel finds where its ray from the camera meets the smooth sphere (not the mesh's
// flat facets), samples the cloud cover there, lights it (tops by the sun, undersides greyer where
// the cloud is thick) with the sunlight that gets through the air, and hazes it with the air in
// between, like everything else.
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;
uniform float uSeed, uCloudR;
uniform samplerCube uCloudTex; // the baked large-scale cloud pattern (clouds.glsl)
uniform int uType;
uniform mat3 uToLocal; // world axes → the world's own frame (it turns)
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_clouds
#pragma farlight_atmo
void main(){
  #include <logdepthbuf_fragment>
  float dist = length(vWP);
  vec3 dir = vWP / dist;
  // the sphere's hits along the ray: take the one nearest this fragment
  float b = dot(dir, uAtC), c = dot(uAtC, uAtC) - uCloudR * uCloudR, disc = b * b - c;
  if (disc < 0.0) discard;
  float sq = sqrt(disc), t0 = b - sq, t1 = b + sq;
  float t = abs(t0 - dist) < abs(t1 - dist) ? t0 : t1;
  if (t <= 0.0) discard;
  vec3 P = dir * t;
  vec3 n = normalize(P - uAtC);
  vec3 p = uToLocal * n;
  // the baked pattern, plus finer octaves (independent detail) as the pixels get smaller
  float fw = max(length(fwidth(p)), 1e-9);
  int oct = int(clamp(log2(0.5 / (2.0 * fw)) + 1.0, 3.0, 11.0));
  float raw = textureCube(uCloudTex, p).r, a = 0.5 * pow(0.5, 7.0), k = 2.0 * pow(2.03, 7.0);
  for (int i = 7; i < 11; i++) {
    if (i >= oct) break;
    raw += a * tnoise(p * k + float(i) * 3.1);
    a *= 0.5;
    k *= 2.03;
  }
  float cov = cloudCover(raw);
  if (cov < 0.004) discard;
  vec3 L = normalize(uLight);
  float lit = clamp(dot(n, L) * 1.05 + 0.05, 0.0, 1.0);
  bool below = length(uAtC) < uCloudR; // the camera is under the deck
  vec3 col = vec3(0.97) * lit * atSunlight(P, L) * (below ? 0.3 + 0.55 * (1.0 - cov) : 1.0);
  vec3 trans;
  vec3 haze = atInscatter(dir * atSpan(dir).x, P, L, trans, 5);
  gl_FragColor = vec4(col * trans + haze, cov * 0.95);
}
