// Milky Way, sampled from the cube map baked once at startup (see SceneRenderer.buildSky).
// The bake stores sqrt(colour) in 8 bits so the faint parts of the band don't band; square it back.
// Through the periscope a sharper patch baked for the view (projected with its camera's matrix)
// replaces the cube inside its frame, fading into it at the edges; a new patch crossfades from the
// previous one (uMix) so re-bakes never pop.
uniform samplerCube uSky;
uniform sampler2D uPatch, uPatchPrev;
uniform mat4 uPatchVP, uPatchPrevVP;
uniform float uPatchOn, uMix;
uniform float uSkyExp; // the Milky Way's share of the exposure (SKY_EXP_P, render/exposure.ts)
varying vec3 vDir;
vec3 patchOr(sampler2D t, mat4 vp, vec3 d, vec3 base){
  vec4 q=vp*vec4(d,1.0);
  if(q.w<=0.0) return base;
  vec2 n=q.xy/q.w;
  float e=max(abs(n.x),abs(n.y));
  if(e>=1.0) return base;
  return mix(base,texture2D(t,n*0.5+0.5).rgb,1.0-smoothstep(0.85,1.0,e));
}
void main(){
  vec3 d=normalize(vDir);
  vec3 c=textureCube(uSky,d).rgb;
  // uPatchOn is a weight (0…1): the patch blends in gradually as the zoom grows
  if(uPatchOn>0.0) c=mix(c,mix(patchOr(uPatchPrev,uPatchPrevVP,d,c),patchOr(uPatch,uPatchVP,d,c),uMix),uPatchOn);
  gl_FragColor=vec4(c*c*uSkyExp,1.0);
}
