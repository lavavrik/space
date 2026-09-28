// The sky: a shell round the world at the top of its air, drawn from inside and out. Each pixel
// takes the ray from the camera through it, finds the stretch inside the air (up to the ground if
// it hits it) and adds the light scattered along it (atmo.glsl): blue overhead and pale at the
// horizon from the ground, a glowing limb from orbit, red at sunset. It also dims what's behind in
// proportion to how bright it is (blending: dst × alpha), so daylight hides the stars.
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_atmo
void main(){
  #include <logdepthbuf_fragment>
  vec3 dir = normalize(vWP);
  vec2 s = atSpan(dir);
  if (s.y <= s.x) discard;
  // stop at the ground
  float b = dot(dir, uAtC), cg = dot(uAtC, uAtC) - uAtR * uAtR, dg = b * b - cg;
  if (dg > 0.0 && b - sqrt(dg) > 0.0) s.y = min(s.y, b - sqrt(dg));
  vec3 trans;
  vec3 sky = atInscatter(dir * s.x, dir * s.y, normalize(uLight), trans, 8);
  float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  float keep = clamp(1.0 - lum * 5.0, 0.0, 1.0) * dot(trans, vec3(0.333));
  gl_FragColor = vec4(sky, keep);
}
