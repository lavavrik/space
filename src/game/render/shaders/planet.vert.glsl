// Planets: the far sphere (a unit sphere scaled by the radius) or, with TERRAIN, one chunk of the
// cube-sphere terrain (render/Terrain.ts): `position` is the undisplaced point relative to the
// chunk's centre (m), aDir its unit direction, aGrid its place in the chunk's grid (skirt vertices
// share their edge vertex's). Skirt vertices (aSkirt = 1) hang below the edges to hide cracks.
//
// The terrain is expensive to evaluate (17 octaves, craters, a shadow march), so it isn't done per
// frame: with TERRAIN_BAKE this shader runs once per chunk as points, one per grid vertex (and
// again whenever the sun has moved), writing into the chunk's bake texture, two texels per vertex:
//   (2x, y)     normal.xyz, elevation (m)
//   (2x + 1, y) sun (1 lit, 0 in a mountain's shadow), h with the chunk's octaves, range mask
// and the drawing pass (TERRAIN) just reads it. The vertices carry uVOct octaves (as many as their
// spacing can show); the fragment shader adds the finer ones from there (terrHFrom).
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP; varying float vOct;
varying float vShadow; // 1 lit, 0 in a mountain's shadow
varying float vHc, vMask; // the terrain h and range mask the geometry has (terrHFrom continues them)
varying vec3 vHaze, vHazeT, vSun; // terrain: the air's haze, its transmittance, and the sunlight here (atmo.glsl), per vertex
varying vec3 vOffDir; // terrain: direction minus the chunk centre's (precise; terrain.glsl terrQ)
#if defined(TERRAIN) || defined(TERRAIN_BAKE)
attribute vec3 aDir; attribute vec2 aGrid; attribute float aSkirt;
uniform float uVOct, uSpacing, uSkirtD;
uniform float uGridW; // vertices per grid row (N + 1)
#endif
#ifdef TERRAIN
uniform float uRadius;
uniform highp sampler2D uBake;
uniform vec3 uLight;
#pragma farlight_atmo
#endif
#ifdef TERRAIN_BAKE
uniform float uSea;
uniform int uType;
uniform vec3 uLightL; // direction to the star in the world's own frame
uniform float uParity; // which of the vertex's two texels this pass writes
flat varying vec4 vBake;
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_terrain
float elevAt(vec3 d, int vo){ float c; bool sea = uType == 2 || uType == 3; return terrElev(terrH(d, vo, vo, c), uSea, sea); }
// the same at the vertex's direction plus a small precise offset (terrQ)
float elevOff(vec3 d, vec3 off, int vo){ tUseOff = uUseQc > 0.5; tOffDir = off; float e = elevAt(d, vo); tUseOff = false; return e; }

#define SHADOW_STEPS 12
#define SHADOW_OCT 9   // mountains and big craters cast shadows; finer relief only shades itself
// March from P (world's frame, m from its centre) toward the sun L. Steps grow geometrically from a
// couple of vertex spacings to 60 relief amplitudes (a 12 km peak's shadow at a 3° sun), stopping
// once the ray is above the highest terrain. Soft edge: the closest the ray passes over the ground
// against the distance travelled, as for a sun of a few degrees. Per vertex, so shadows are as sharp
// as the chunk is detailed, i.e. about the same on screen near and far.
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
#ifdef TERRAIN_BAKE
  int vo = int(uVOct + 0.5);
  float hc;
  bool sea = uType == 2 || uType == 3;
  vec3 off = position / uRadius; // the point's direction minus the chunk centre's
  tUseOff = uUseQc > 0.5;
  tOffDir = off;
  float h = terrH(aDir, vo, vo, hc);
  tUseOff = false;
  float mask = tMask;
  float e = terrElev(h, uSea, sea);
  if (uParity < 0.5) {
    // normal from the slope: two samples a vertex spacing away along the surface
    vec3 t1 = normalize(cross(aDir, abs(aDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(aDir, t1);
    float eps = uSpacing / uRadius;
    float e1 = elevOff(normalize(aDir + t1 * eps), off + t1 * eps, vo), e2 = elevOff(normalize(aDir + t2 * eps), off + t2 * eps, vo);
    vBake = vec4(normalize(aDir - t1 * ((e1 - e) / uSpacing) - t2 * ((e2 - e) / uSpacing)), e);
  } else {
    float sun = dot(aDir, uLightL) < -0.2 ? 0.0 : sunShadow(aDir * (uRadius + e), uLightL, vo); // night side: dark anyway
    vBake = vec4(sun, h, mask, 0.0);
  }
  vec2 texel = vec2(2.0 * aGrid.x + uParity + 0.5, aGrid.y + 0.5) / vec2(2.0 * uGridW, uGridW);
  gl_Position = vec4(texel * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
#else
#ifdef TERRAIN
  ivec2 g = ivec2(aGrid + 0.5);
  vec4 A = texelFetch(uBake, ivec2(2 * g.x, g.y), 0), B = texelFetch(uBake, ivec2(2 * g.x + 1, g.y), 0);
  vec3 pos = position + aDir * (A.w - aSkirt * uSkirtD), n = A.xyz;
  vObj = aDir;
  vOffDir = position / uRadius;
  vOct = uVOct;
  vShadow = B.x;
  vHc = B.y;
  vMask = B.z;
#else
  vec3 pos = position, n = normal;
  vObj = position;
  vOct = 0.0;
  vShadow = 1.0;
  vHc = 0.0;
  vMask = 0.0;
  vOffDir = vec3(0.0);
#endif
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWP = wp.xyz;
#ifdef TERRAIN
  // the air between the camera and here varies smoothly: worked out per vertex, not per pixel
  // (at the ground: skirt vertices hang far below it, where the air's density would blow up)
  vec3 ground = (modelMatrix * vec4(pos + aDir * aSkirt * uSkirtD, 1.0)).xyz;
  vec3 L = normalize(uLight), vd = normalize(ground);
  vHaze = atInscatter(vd * atSpan(vd).x, ground, L, vHazeT, 5);
  vSun = atSunlight(ground, L);
#endif
  vWN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
#endif
}
