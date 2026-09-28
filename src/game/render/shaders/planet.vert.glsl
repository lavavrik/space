// Planets: the far sphere (a unit sphere scaled by the radius) or, with TERRAIN, one chunk of the
// cube-sphere terrain (render/Terrain.ts): `position` is the undisplaced point relative to the
// chunk's centre (m), aDir its unit direction, and the vertex is raised by the terrain height with
// uVOct octaves (as many as the chunk's vertex spacing can show; the fragment shader bump-maps the
// rest). Skirt vertices (aSkirt = 1) hang below the edges to hide cracks between chunk levels.
// Terrain vertices also work out whether the ground between them and the sun hides it (vShadow):
// a march toward the sun over the height field, at the vertex density, so shadows are as sharp as
// the chunk is detailed, i.e. about the same on screen near and far.
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP; varying float vOct;
varying float vShadow; // 1 lit, 0 in a mountain's shadow
#ifdef TERRAIN
attribute vec3 aDir; attribute float aSkirt;
uniform float uVOct, uSpacing, uSkirtD, uSea;
uniform int uType;
uniform vec3 uLight; // direction to the star, world axes
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_terrain
float elevAt(vec3 d, int vo){ float c; bool sea = uType == 2 || uType == 3; return terrElev(terrH(d, vo, vo, c), uSea, sea); }

#define SHADOW_STEPS 12
#define SHADOW_OCT 9   // mountains and big craters cast shadows; finer relief only shades itself
// March from P (world's frame, m from its centre) toward the sun L. Steps grow geometrically from a
// couple of vertex spacings to 60 relief amplitudes (a 12 km peak's shadow at a 3° sun), stopping
// once the ray is above the highest terrain. Soft edge: the closest the ray passes over the ground
// against the distance travelled, as for a sun of a few degrees.
float sunShadow(vec3 P, vec3 L, int vo){
  int so = min(vo, SHADOW_OCT);
  float t0 = uSpacing * 2.0, tMax = 60.0 * uTerrA;
  float g = pow(tMax / t0, 1.0 / float(SHADOW_STEPS - 1));
  float top = uRadius + 2.6 * uTerrA;
  float lit = 1.0, t = t0;
  for (int k = 0; k < SHADOW_STEPS; k++) {
    vec3 Q = P + L * t;
    float rq = length(Q);
    if (rq > top && dot(Q, L) > 0.0) break;
    float clear = rq - uRadius - elevAt(Q / rq, so) + uSpacing * 0.3;
    lit = min(lit, 12.0 * clear / t);
    if (lit <= 0.0) break;
    t *= g;
  }
  return clamp(lit, 0.0, 1.0);
}
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
  // the sun in the world's frame (chunks aren't scaled, so the model matrix is a pure rotation here)
  vec3 Ll = normalize(transpose(mat3(modelMatrix)) * uLight);
  float up = dot(aDir, Ll);
  vShadow = up < -0.2 ? 0.0 : sunShadow(aDir * (uRadius + e), Ll, vo); // night side: dark anyway
#else
  vec3 pos = position, n = normal;
  vObj = position;
  vOct = 0.0;
  vShadow = 1.0;
#endif
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWP = wp.xyz;
  vWN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
