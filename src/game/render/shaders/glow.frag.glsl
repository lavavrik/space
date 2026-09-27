#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uI;
varying vec2 vP;
void main(){
  #include <logdepthbuf_fragment>
  float r=length(vP);
  float core=exp(-r*r*22.0);
  float halo=pow(max(1.0-r,0.0),4.0)*0.5;
  float fall=pow(max(1.0-r,0.0),2.0);
  float spikes=(exp(-abs(vP.x)*110.0)+exp(-abs(vP.y)*110.0))*fall*0.45;
  vec3 c=(mix(uColor,vec3(1.0),core)*(core+halo)+uColor*spikes)*uI;
  // display-referred and kept out of the exposure meter (render/exposure.ts): a star in view
  // doesn't dim the sky. Blended: colour adds, alpha 0 masks the meter weight underneath.
  gl_FragColor=vec4(c,0.0);
}
