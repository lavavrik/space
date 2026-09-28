// A corridor lamp: a soft round dot with a white-hot core. Display-referred (signal light); alpha 0
// keeps it out of the exposure meter (render/hdr.ts).
#include <logdepthbuf_pars_fragment>
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * 3.0) * (1.0 - smoothstep(0.8, 1.0, r));
  vec3 c = vC * a;
  c += vec3(max(0.0, max(c.r, max(c.g, c.b)) - 0.8) * 0.6);
  gl_FragColor = vec4(c, 0.0);
}
