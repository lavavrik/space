// Milky Way, sampled from the cube map baked once at startup (see SceneRenderer.buildSky).
// The bake stores sqrt(colour) in 8 bits so the faint parts of the band don't band; square it back.
// Through the periscope a sharper patch baked for the current view (uPatch, projected with the
// patch camera's uPatchVP) replaces the cube inside its frame, fading into it at the edges.
uniform samplerCube uSky;
uniform sampler2D uPatch;
uniform mat4 uPatchVP;
uniform float uPatchOn;
varying vec3 vDir;
void main(){
  vec3 d=normalize(vDir);
  vec3 c=textureCube(uSky,d).rgb;
  if(uPatchOn>0.5){
    vec4 q=uPatchVP*vec4(d,1.0);
    if(q.w>0.0){
      vec2 n=q.xy/q.w;
      float e=max(abs(n.x),abs(n.y));
      if(e<1.0) c=mix(c,texture2D(uPatch,n*0.5+0.5).rgb,1.0-smoothstep(0.85,1.0,e));
    }
  }
  gl_FragColor=vec4(c*c,1.0);
}
