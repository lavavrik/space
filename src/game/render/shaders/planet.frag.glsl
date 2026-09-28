#include <logdepthbuf_pars_fragment>
uniform int uType; uniform int uOct;
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform vec3 uD;
uniform vec3 uAtmo; uniform float uAtmoK; uniform float uSea; uniform float uSeed; uniform float uTime; uniform vec3 uLight;
uniform float uExp; // exposure (render/exposure.ts)
uniform float uCamAlt; // camera height above the mean radius (m)
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
varying float vOct; // octaves the geometry already shows (0 on the far sphere; planet.vert.glsl)
varying float vShadow; // mountains' shadows (1 lit; planet.vert.glsl)
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_terrain
// Bump mapping from a height field H (m) over the surface, from screen-space derivatives
// (Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU"): tilts N by H's slope.
vec3 bumpN(vec3 N, float H){
  vec3 dpx = dFdx(vWP), dpy = dFdy(vWP);
  float dhx = dFdx(H), dhy = dFdy(H);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  if (abs(det) < 1e-30) return N;
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}
void main(){
  #include <logdepthbuf_fragment>
  vec3 p=normalize(vObj);
  vec3 N=normalize(vWN); vec3 V=normalize(-vWP); vec3 L=normalize(uLight);
  float ndl=dot(N,L);
  float ndl0=ndl; // the smooth surface's, for clouds (they float above the relief)
  vec3 sp=p*1.6+vec3(uSeed*1.7,uSeed*2.3,uSeed*0.9);
  // Octaves per pixel: stop once an octave's features are smaller than the pixel's footprint on the
  // surface (fwidth of the surface position), never more than the terrain has (17: tens of metres
  // on an Earth, so detail keeps coming as you descend), and within uOct (from the planet's size on
  // screen).
  float fw=max(length(fwidth(p)),1e-9);
  int oct=min(uOct,int(clamp(log2(0.5/(1.6*fw))/1.02+1.0,3.0,float(T_OCT_MAX))));
  // Night side: at 0.8 % brightness the detail is invisible, so skip it (volcanic worlds glow at night)
  bool dark=clamp(ndl*1.05+0.03,0.0,1.0)<0.002&&uType!=4;
  if(dark) oct=min(oct,3);
  vec3 col; vec3 emit=vec3(0.0); float spec=0.0; float cloud=0.0; float det=1.0;
  if(uType>=6){
    bool gas = uType==6;
    float w=fbmF(vec3(sp.x*1.2,sp.y*5.0,sp.z*1.2),min(oct,6));
    float lat=p.y+w*(gas?0.07:0.025);
    float b1=sin(lat*(gas?26.0:9.0)+uSeed)*0.5+0.5;
    float b2=sin(lat*(gas?63.0:21.0)+uSeed*3.0)*0.5+0.5;
    col=mix(uA,uB,b1);
    col=mix(col,uC,b2*0.35);
    float turb=dark?0.0:fbmF(sp*vec3(3.0,14.0,3.0)+w*2.0,min(oct,8));
    col*=0.9+0.22*turb;
    vec3 sc=normalize(vec3(cos(uSeed*5.0),-0.3,sin(uSeed*5.0)));
    float sd=length((p-sc)*vec3(1.0,1.8,1.0));
    float storm=smoothstep(0.16,0.05,sd+0.03*turb);
    col=mix(col,uD,storm*(gas?0.85:0.6));
  } else {
    // terrain height (terrain.glsl): the same h the geometry is raised by; octaves finer than the
    // geometry shows (from vOct) light the surface as bumps instead
    float hc;
    float h=terrH(p,oct,int(vOct+0.5),hc);
    bool seaOn=uType==2||uType==3;
    N=bumpN(N,terrElev(h,uSea,seaOn)-terrElev(hc,uSea,seaOn));
    det=1.0+0.1*tDet; // rock and soil variation at every scale (terrain.glsl)
    float h2=dark?0.0:fbmF(sp*3.1+4.0,min(max(oct-2,3),5));
    float lat=abs(p.y);
    if(uType==0){
      float cr=1.0-abs(snoise(sp*5.0+h));
      col=mix(uA,uB,smoothstep(-0.5,0.6,h));
      col*=0.78+0.35*pow(cr,4.0);
      col=mix(col,uC,smoothstep(0.25,0.7,h2)*0.4);
    } else if(uType==1){
      float d=sin((p.x+p.z)*90.0+h*14.0)*0.5+0.5;
      col=mix(uA,uB,smoothstep(-0.4,0.5,h));
      col=mix(col,uC,d*0.12+smoothstep(0.35,0.8,h2)*0.4);
      col=mix(col,vec3(0.92),smoothstep(0.9,0.96,lat+h*0.05));
    } else if(uType==2||uType==3){
      if(h<uSea){
        float dep=clamp((uSea-h)*4.0,0.0,1.0);
        col=mix(uB,uA,dep); spec=1.0;
      } else {
        float e=h-uSea;
        col=mix(uC,uD,smoothstep(0.12,0.55,e+h2*0.12)); // lowlands green, highlands and ranges rock
        col=mix(col,uC*0.7+vec3(0.18,0.15,0.08),smoothstep(0.2,0.6,h2)*0.3);
        col=mix(col,vec3(0.9),smoothstep(0.62,0.75,e)); // snow on the high peaks (mountain ranges raise h)
      }
      float ice=smoothstep(0.8,0.86,lat+h*0.1);
      col=mix(col,vec3(0.93,0.95,1.0),ice); spec*=1.0-ice;
      vec3 cp=sp*1.25+vec3(uTime*0.003,0.0,uTime*0.0017);
      // clouds: the 4-octave warp sets their pattern, so it stays; their own detail stops at 6 octaves
      float c=dark?0.0:fbmF(cp+fbmF(cp*2.0,4)*0.7,min(max(oct-1,4),6));
      // the clouds are painted on the ground: from below ~25 km they'd sit on the mountains, so
      // they thin out as you descend through the cloud deck
      cloud=smoothstep(0.02,0.5,c)*(uType==3?0.95:0.85)*smoothstep(4e3,25e3,uCamAlt);
    } else if(uType==4){
      float cr=1.0-abs(snoise(sp*3.0+h));
      float cr2=1.0-abs(snoise(sp*9.0+h2*2.0));
      col=mix(uA,uB,smoothstep(-0.3,0.6,h));
      float glow=pow(cr,14.0)+pow(cr2,18.0)*0.6;
      emit=uC*glow*1.4;
      col*=1.0-glow*0.6;
    } else {
      float cr=1.0-abs(snoise(sp*4.0+h*2.0));
      col=mix(uA,uB,smoothstep(-0.5,0.5,h));
      col=mix(col,uC,pow(cr,22.0)*0.75);
    }
  }
  col*=mix(det,1.0,spec); // not on water
  ndl=dot(N,L);
  float diff=clamp(ndl*1.05+0.03,0.0,1.0)*vShadow;
  float diff0=clamp(ndl0*1.05+0.03,0.0,1.0);
  vec3 R=reflect(-L,N);
  float s=pow(max(dot(R,V),0.0),60.0)*0.7*spec*diff;
  // the night side is lit only by starlight: sky level (SKY_K), so it goes black against the stars
  col=col*(diff+0.0002)+vec3(1.0,0.95,0.85)*s;
  col=mix(col,vec3(1.0)*(diff0*0.97+0.00015),cloud);
  float rim=pow(1.0-max(dot(N,V),0.0),3.0);
  col+=uAtmo*uAtmoK*rim*clamp(ndl+0.25,0.0,1.0)*1.1;
  col=mix(col,uAtmo*diff,uAtmoK*0.08);
  col+=emit;
  gl_FragColor=vec4(col*uExp,1.0);
}
