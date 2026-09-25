#include <logdepthbuf_pars_fragment>
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float r=length(gl_PointCoord-0.5)*2.0;
  float a=exp(-r*r*3.5)*(1.0-smoothstep(0.8,1.0,r));
  gl_FragColor=vec4(vC*a,1.0);
}
