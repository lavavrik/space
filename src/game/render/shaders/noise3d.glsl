// Fast fBm for the planet shaders: the first FBM_EXACT octaves are exact simplex noise (they set the
// continents and cloud shapes); finer ones read a tileable 3D gradient-noise texture (lib/noise3d.ts),
// one trilinear fetch each. 1 unit of p = one lattice cell; the texture holds 8 cells per axis.
uniform highp sampler3D uNoise3D;
#define FBM_EXACT 3
float tnoise(vec3 p){ return texture(uNoise3D,p*0.125).r*2.0-1.0; }
// The same, filtered here at full precision: the GPU's own filter weights have only 8 bits (1/256 of
// a texel), which through the periscope turns the noise into fine steps that the bump shading shows as
// moiré. p should be small (terrain chunks wrap it by the texture's 8-cell period).
float tnoiseHQ(vec3 p){
  vec3 x = p * 8.0 - 0.5;
  vec3 i0 = floor(x), f = x - i0;
  ivec3 a = ivec3(mod(i0, 64.0)), b = ivec3(mod(i0 + 1.0, 64.0));
  float c000 = texelFetch(uNoise3D, ivec3(a.x, a.y, a.z), 0).r, c100 = texelFetch(uNoise3D, ivec3(b.x, a.y, a.z), 0).r;
  float c010 = texelFetch(uNoise3D, ivec3(a.x, b.y, a.z), 0).r, c110 = texelFetch(uNoise3D, ivec3(b.x, b.y, a.z), 0).r;
  float c001 = texelFetch(uNoise3D, ivec3(a.x, a.y, b.z), 0).r, c101 = texelFetch(uNoise3D, ivec3(b.x, a.y, b.z), 0).r;
  float c011 = texelFetch(uNoise3D, ivec3(a.x, b.y, b.z), 0).r, c111 = texelFetch(uNoise3D, ivec3(b.x, b.y, b.z), 0).r;
  float c = mix(mix(mix(c000, c100, f.x), mix(c010, c110, f.x), f.y), mix(mix(c001, c101, f.x), mix(c011, c111, f.x), f.y), f.z);
  return c * 2.0 - 1.0;
}
float fbmF(vec3 p,int oct){float a=0.5,s=0.0;for(int i=0;i<14;i++){if(i>=oct)break;s+=a*(i<FBM_EXACT?snoise(p):tnoise(p));p=p*2.03+vec3(1.7,9.2,3.1);a*=0.5;}return s;}
