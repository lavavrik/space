// Bakes the cloud pattern into a cube map (render/SceneRenderer.ts): a sphere round the cube camera,
// each pixel the raw cloud value (clouds.glsl) in its direction (the world's own frame).
uniform float uSeed;
uniform int uType;
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_clouds
void main(){ gl_FragColor = vec4(cloudRaw(normalize(vObj), 7), 0.0, 0.0, 1.0); }
