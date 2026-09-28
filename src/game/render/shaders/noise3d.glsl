// Fast fBm for the planet shaders: the first FBM_EXACT octaves are exact simplex noise (they set the
// continents and cloud shapes); finer ones read a tileable 3D gradient-noise texture (lib/noise3d.ts),
// one trilinear fetch each. 1 unit of p = one lattice cell; the texture holds 8 cells per axis.
uniform highp sampler3D uNoise3D;
#define FBM_EXACT 3
float tnoise(vec3 p){ return texture(uNoise3D,p*0.125).r*2.0-1.0; }
float fbmF(vec3 p,int oct){float a=0.5,s=0.0;for(int i=0;i<14;i++){if(i>=oct)break;s+=a*(i<FBM_EXACT?snoise(p):tnoise(p));p=p*2.03+vec3(1.7,9.2,3.1);a*=0.5;}return s;}
