#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uTime; uniform float uSeed;
uniform float uExp; // exposure (render/exposure.ts)
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
void main(){
  #include <logdepthbuf_fragment>
  vec3 p=normalize(vObj); vec3 N=normalize(vWN); vec3 V=normalize(-vWP);
  float mu=clamp(dot(N,V),0.0,1.0);
  float g=snoise(p*45.0+uTime*0.04)*0.5+snoise(p*120.0-uTime*0.07)*0.3+fbm(p*5.0+uSeed,4)*0.5;
  float limb=0.35+0.65*pow(mu,0.45);
  vec3 c=mix(uColor,vec3(1.0),0.6*mu)*limb*(1.0+0.13*g);
  // the disc is far brighter than anything it lights (STAR_K = 1000; really ~1e5), kept in half-float range
  gl_FragColor=vec4(min(c*1.2*1000.0*uExp,vec3(6e4)),1.0);
}
