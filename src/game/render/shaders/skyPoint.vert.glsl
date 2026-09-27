// STAR_SIZE: every star's mark is drawn this much bigger than skyLook's size, so stars read as
// clear points, not specks
const float STAR_SIZE = 1.5;
attribute float aSize; attribute vec3 aColor; varying vec3 vC; uniform float uPR;
void main(){ vC=aColor; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); gl_PointSize=aSize*uPR*STAR_SIZE; }
