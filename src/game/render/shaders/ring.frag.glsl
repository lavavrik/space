#include <logdepthbuf_pars_fragment>
uniform vec3 uColor; uniform vec3 uLight; uniform vec3 uPC; uniform float uPR; uniform float uIn; uniform float uOut; uniform float uSeed;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
void main(){
  #include <logdepthbuf_fragment>
  float r=length(vObj.xy);
  float t=(r-uIn)/(uOut-uIn);
  float band=0.55+0.35*snoise(vec3(r*14.0,uSeed,0.0))+0.25*snoise(vec3(r*60.0,uSeed,1.0));
  float alpha=smoothstep(0.0,0.06,t)*smoothstep(1.0,0.86,t)*clamp(band,0.0,1.0)*0.85;
  alpha*=smoothstep(0.015,0.04,abs(t-0.63));
  vec3 L=normalize(uLight);
  vec3 toP=vWP-uPC; float along=dot(toP,L);
  float perp=length(toP-along*L);
  float sh=(along<0.0&&perp<uPR)?0.06:1.0;
  float lit=0.35+0.65*abs(dot(normalize(vWN),L));
  gl_FragColor=vec4(uColor*lit*sh,alpha);
}
