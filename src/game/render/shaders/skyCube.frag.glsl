// Milky Way, sampled from the cube map baked once at startup (see SceneRenderer.buildSky).
// The bake stores sqrt(colour) in 8 bits so the faint parts of the band don't band; square it back.
uniform samplerCube uSky;
varying vec3 vDir;
void main(){
  vec3 c=textureCube(uSky,normalize(vDir)).rgb;
  gl_FragColor=vec4(c*c,1.0);
}
