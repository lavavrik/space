// Cloud cover. The large-scale pattern (the same the surface used to be painted with) is baked once
// per world into a cube map in the world's own frame (render/SceneRenderer.ts, CLOUD_BAKE_FS):
// cloudRaw is what the bake evaluates, cloudCover turns a raw value into cover (0…1). The cloud
// layer adds a few finer octaves on top up close; cloud shadows on the ground just read the map.
// cloudRaw needs fbmF, uSeed; cloudCover needs uType.
float cloudRaw(vec3 p, int oct){
  vec3 cp = (p * 1.6 + vec3(uSeed * 1.7, uSeed * 2.3, uSeed * 0.9)) * 1.25;
  return fbmF(cp + fbmF(cp * 2.0, 4) * 0.7, oct);
}
float cloudCover(float raw){ return smoothstep(0.02, 0.5, raw) * (uType == 3 ? 0.95 : 0.85); }
