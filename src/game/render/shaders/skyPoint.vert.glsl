attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uPR;
void main(){ vC=aColor; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uPR; }
