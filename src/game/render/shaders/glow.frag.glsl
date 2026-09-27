#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uI;
uniform float uExp; // exposure (render/exposure.ts)
varying vec2 vP;
void main(){
  #include <logdepthbuf_fragment>
  float r=length(vP);
  float core=exp(-r*r*22.0);
  float halo=pow(max(1.0-r,0.0),4.0)*0.5;
  float fall=pow(max(1.0-r,0.0),2.0);
  float spikes=(exp(-abs(vP.x)*110.0)+exp(-abs(vP.y)*110.0))*fall*0.45;
  vec3 c=(mix(uColor,vec3(1.0),core)*(core+halo)+uColor*spikes)*uI;
  gl_FragColor=vec4(min(c*2.0*uExp,vec3(6e4)),1.0); // GLOW_K = 2
}
