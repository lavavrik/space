// The approach corridor: a faint box of green light running out from a station's slot along its
// spin axis while you have a pad there (unit coordinates, see render/stationMesh.ts). Bright along
// its four edges, faint across its walls, with pulses running in toward the slot; it fades out
// with distance from the station.
#include <logdepthbuf_pars_fragment>
uniform float uTime;
uniform float uLen;        // corridor length (unit coordinates)
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
void main(){
  #include <logdepthbuf_fragment>
  float along = clamp((vObj.z - 0.5) / uLen, 0.0, 1.0);    // 0 at the slot, 1 at the far end
  // the corridor widens with distance: normalise the cross-section to its half-size here
  float grow = 1.0 + along * 1.5;
  vec2 q = abs(vObj.xy) / (vec2(0.2, 0.06) * grow);
  float edge = smoothstep(0.93, 1.0, min(q.x, q.y));          // near a corner line
  float pulse = pow(fract(along * 6.0 + uTime * 0.6), 8.0);   // bands running in toward the slot
  float a = (0.05 + 0.5 * edge + 0.35 * pulse) * (1.0 - along) * (1.0 - along);
  gl_FragColor = vec4(vec3(0.25, 1.0, 0.55) * a, 1.0);
}
