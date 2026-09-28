// Planets: the far sphere (a unit sphere scaled by the radius) or, with TERRAIN, one chunk of the
// cube-sphere terrain (render/Terrain.ts): `position` is the undisplaced point relative to the
// chunk's centre (m), aDir its unit direction, and the vertex is raised by the terrain height with
// uVOct octaves (as many as the chunk's vertex spacing can show; the fragment shader bump-maps the
// rest). Skirt vertices (aSkirt = 1) hang below the edges to hide cracks between chunk levels.
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP; varying float vOct;
#ifdef TERRAIN
attribute vec3 aDir; attribute float aSkirt;
uniform float uVOct, uRadius, uSpacing, uSkirtD, uSea;
uniform int uType;
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_terrain
float elevAt(vec3 d, int vo){ float c; bool sea = uType == 2 || uType == 3; return terrElev(terrH(d, vo, vo, c), uSea, sea); }
#endif
void main(){
#ifdef TERRAIN
  int vo = int(uVOct + 0.5);
  float e = elevAt(aDir, vo);
  // normal from the slope: two samples a vertex spacing away along the surface
  vec3 t1 = normalize(cross(aDir, abs(aDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(aDir, t1);
  float eps = uSpacing / uRadius;
  float e1 = elevAt(normalize(aDir + t1 * eps), vo), e2 = elevAt(normalize(aDir + t2 * eps), vo);
  vec3 n = normalize(aDir - t1 * ((e1 - e) / uSpacing) - t2 * ((e2 - e) / uSpacing));
  vec3 pos = position + aDir * (e - aSkirt * uSkirtD);
  vObj = aDir;
  vOct = uVOct;
#else
  vec3 pos = position, n = normal;
  vObj = position;
  vOct = 0.0;
#endif
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWP = wp.xyz;
  vWN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
