#include <logdepthbuf_pars_fragment>
uniform vec3 uAtmo; uniform vec3 uLight; uniform float uK; uniform float uEdge;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
void main(){
  #include <logdepthbuf_fragment>
  vec3 N=normalize(vWN); vec3 V=normalize(-vWP);
  float d=-dot(N,V);
  float a=pow(clamp(d/uEdge,0.0,1.0),2.2);
  float l=clamp(dot(N,normalize(uLight))+0.3,0.0,1.0);
  gl_FragColor=vec4(uAtmo*a*l*uK,1.0);
}
