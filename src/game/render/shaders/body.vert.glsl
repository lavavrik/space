#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
void main(){
  vObj=position;
  vec4 wp=modelMatrix*vec4(position,1.0);
  vWP=wp.xyz;
  vWN=normalize(mat3(modelMatrix)*normal);
  gl_Position=projectionMatrix*viewMatrix*wp;
  #include <logdepthbuf_vertex>
}
