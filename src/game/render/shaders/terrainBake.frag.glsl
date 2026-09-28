// The terrain bake pass (planet.vert.glsl with TERRAIN_BAKE): each point writes its value as is.
flat varying vec4 vBake;
void main(){ gl_FragColor = vBake; }
