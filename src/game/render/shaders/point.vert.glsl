#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSize; attribute vec3 aColor; varying vec3 vC;
void main(){ vC=aColor; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize;
  #include <logdepthbuf_vertex>
}
