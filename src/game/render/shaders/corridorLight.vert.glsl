// Entry corridor approach lights (render/stationMesh.ts corridorLights): one point per light, a
// lamp ~LAMP_M across that never shrinks below a few pixels, so the corridor reads from far out.
// A pulse runs down each row toward the slot, like a runway's sequenced flashers. While another
// ship has the slot (uBusy) every lamp turns amber, the pulses running the way it's going (uDir:
// +1 in, −1 out): a traffic light for the corridor (sim/control.ts).
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAlong, aSide;
uniform float uTime, uPxPerRad, uSize; // uSize: the station's size (m), to turn unit coordinates into metres
uniform float uBusy, uDir;
varying vec3 vC;
#define LAMP_M 30.0
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float dist = length(mv.xyz);
  gl_PointSize = clamp(LAMP_M / dist * uPxPerRad, 3.0, 14.0);
  float run = pow(fract(aAlong * 6.0 + uDir * uTime * 0.7), 10.0);
  vec3 c = uBusy > 0.5 ? vec3(1.0, 0.62, 0.12) : aSide > 0.0 ? vec3(0.25, 1.0, 0.45) : vec3(1.0, 0.25, 0.18);
  vC = c * (0.55 + 1.6 * run) * (1.0 - 0.35 * aAlong);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
