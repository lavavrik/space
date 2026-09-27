#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform float uTime; uniform float uSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
void main(){
  #include <logdepthbuf_fragment>
  vec3 p=normalize(vObj); vec3 N=normalize(vWN); vec3 V=normalize(-vWP);
  float mu=clamp(dot(N,V),0.0,1.0);
  float g=snoise(p*45.0+uTime*0.04)*0.5+snoise(p*120.0-uTime*0.07)*0.3+fbm(p*5.0+uSeed,4)*0.5;
  float limb=0.35+0.65*pow(mu,0.45);
  vec3 c=mix(uColor,vec3(1.0),0.6*mu)*limb*(1.0+0.13*g);
  // display-referred, and alpha 0 keeps it out of the exposure meter (render/exposure.ts): the
  // star looks the same at any exposure, and having it in view doesn't make the sky go dark
  gl_FragColor=vec4(c*1.2,0.0);
}
