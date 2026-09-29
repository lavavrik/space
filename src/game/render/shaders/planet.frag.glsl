#include <logdepthbuf_pars_fragment>
uniform int uType; uniform int uOct;
uniform vec3 uA; uniform vec3 uB; uniform vec3 uC; uniform vec3 uD;
uniform vec3 uAtmo; uniform float uAtmoK; uniform float uSea; uniform float uSeed; uniform float uTime; uniform vec3 uLight;
uniform float uExp; // exposure (render/exposure.ts)
uniform float uCamAlt; // camera height above the mean radius (m)
uniform vec3 uLightL;  // the sun in the world's own frame (for cloud shadows)
uniform float uCloudH; // the cloud deck's height (m), 0 if none (render: cloud layer)
uniform samplerCube uCloudTex; // the baked cloud pattern (clouds.glsl)
uniform mat3 uToLocal; // world axes → the world's own frame (the far sphere's object frame)
varying vec3 vObj; varying vec3 vWN; varying vec3 vWP;
varying float vOct; // octaves the geometry already shows (0 on the far sphere; planet.vert.glsl)
varying float vShadow; // mountains' shadows (1 lit; planet.vert.glsl)
varying float vHc, vMask; // the terrain h and range mask the geometry already has
varying float vSkirt; // terrain chunks: 0 on the surface, up to 1 down a skirt (planet.vert.glsl)
varying vec3 vHaze, vHazeT, vSun; // terrain chunks: the air's haze and the sunlight, per vertex
varying vec3 vOffDir; // terrain chunks: direction minus the chunk centre's (terrain.glsl terrQ)
#pragma farlight_noise
#pragma farlight_noise3d
#pragma farlight_clouds
#pragma farlight_atmo
#pragma farlight_terrain
#pragma farlight_city
// Bump mapping from a height field H (m) over the surface, from screen-space derivatives
// (Mikkelsen, "Bump Mapping Unparametrized Surfaces on the GPU"): tilts N by H's slope.
vec3 bumpN(vec3 N, float H){
#ifdef TERRAIN
  vec3 dpx = dFdx(vWP), dpy = dFdy(vWP);
#else
  // The far sphere: from the object-space position, turned to world axes. vWP (camera-relative
  // world metres) is ~10¹¹ m away across the system, where float32 steps are kilometres: through
  // the periscope its derivatives were rounding noise, and the relief flashed in a disc where the
  // surface faces you. The object-space position is good to about a metre.
  mat3 toWorld = transpose(uToLocal);
  vec3 dpx = toWorld * dFdx(vObj * uRadius), dpy = toWorld * dFdy(vObj * uRadius);
#endif
  float dhx = dFdx(H), dhy = dFdy(H);
  vec3 r1 = cross(dpy, N), r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  if (abs(det) < 1e-30) return N;
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}
void main(){
  #include <logdepthbuf_fragment>
#ifdef TERRAIN
  // Skirts hang below every chunk's edge to hide the cracks between detail levels. They're almost
  // always hidden behind the ground, but they're still shaded: the log depth buffer writes depth
  // here, which turns off the GPU's early depth test. Seen at a grazing angle through the periscope
  // the horizon is walls of them, and the full ground shader on all of them doubled the frame time
  // or worse. A crack only ever shows a skirt's top, just under the edge (the gap is a small part of
  // its depth), so that keeps the full shader and the rest, far below, gets plain lit ground colour.
  if (vSkirt > 0.5) {
    float d0 = clamp(dot(normalize(vWN), normalize(uLight)) * 1.05 + 0.03, 0.0, 1.0);
    vec3 c0 = mix(uA, uB, 0.5) * (d0 * vShadow * vSun + 0.0002);
    gl_FragColor = vec4((c0 * vHazeT + vHaze) * uExp, 1.0);
    return;
  }
#endif
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
  // (a populated world keeps its coastlines at night: that's where its lights are)
  if(dark) oct=min(oct,uCity>0.5?8:3);
  vec3 col; vec3 emit=vec3(0.0); float spec=0.0; float cloud=0.0; float det=1.0; float elev=0.0;
  float pop=0.0; // population density, for the city lights (cityLights.glsl)
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
    // only the octaves finer than the geometry are worked out here (terrHFrom); the rest come baked
    float hc=vHc;
    tUseOff=uUseQc>0.5; tOffDir=vOffDir; // precise lattice points on terrain chunks
    float h=terrHFrom(p,int(vOct+0.5),oct,vHc,vMask);
    tUseOff=false;
    bool seaOn=uType==2||uType==3;
    elev=terrElev(h,uSea,seaOn);
    N=bumpN(N,elev-terrElev(hc,uSea,seaOn));
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
        if(uCity>0.5) pop=cityPop(p,e,lat);
        col=mix(uC,uD,smoothstep(0.12,0.55,e+h2*0.12)); // lowlands green, highlands and ranges rock
        col=mix(col,uC*0.7+vec3(0.18,0.15,0.08),smoothstep(0.2,0.6,h2)*0.3);
        col=mix(col,vec3(0.9),smoothstep(0.62,0.75,e)); // snow on the high peaks (mountain ranges raise h)
      }
      float ice=smoothstep(0.8,0.86,lat+h*0.1);
      col=mix(col,vec3(0.93,0.95,1.0),ice); spec*=1.0-ice;
      // (the clouds are a layer of their own at the deck's height now: render/SceneRenderer.ts)
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
  // the cloud layer's shadow: the cover where the sun's ray from here crosses the deck
  if(uCloudH>0.0&&!dark){
    float up=dot(p,uLightL);
    if(up>0.0){
      float s=max(uCloudH-elev,0.0)/max(up,0.08);
      cloud=cloudCover(textureCube(uCloudTex,normalize(p*(uRadius+elev)+uLightL*s)).r);
      diff*=1.0-0.75*cloud;
    }
  }
  // sunlight through the air (reddens toward sunset); skylight fills shadows by day
#ifdef TERRAIN
  vec3 sunC=vSun;
#else
  // the far sphere: the air worked out from the world's centre, from the surface point in object space
  // (precise), not from camera-relative world positions: across the system those are ~10¹¹ m, and
  // subtracting the centre from them left kilometres of error in the height, against scale heights of
  // ~10 km, so sunlight and haze flickered through the periscope
  vec3 C1=transpose(uToLocal)*(vObj*uRadius);
  vec3 sunC=atSunlightC(C1,L);
#endif
  float sky=uAtOn>0.5?0.07*smoothstep(-0.12,0.35,ndl0):0.0;
  float diff0=clamp(ndl0*1.05+0.03,0.0,1.0);
  vec3 R=reflect(-L,N);
  float s=pow(max(dot(R,V),0.0),60.0)*0.7*spec*diff;
  // the night side is lit only by starlight: sky level (SKY_K), so it goes black against the stars
  col=col*(diff*sunC+sky+0.0002)+vec3(1.0,0.95,0.85)*s*sunC;
  // city lights, coming on as the sun sets (dimmed like the ground by the air above them, below)
  if(pop>0.0){
    float night=smoothstep(0.1,-0.08,ndl0);
    if(night>0.0){
      float white;
      float lights=cityLights(p,pop,fw,white);
      col+=mix(vec3(1.0,0.62,0.3),vec3(1.0,0.88,0.7),white)*lights*night*uCityK;
    }
  }
  if(uAtOn>0.5){
    // the air between the camera and here: haze (atmo.glsl), which also gives the limb its glow
#ifdef TERRAIN
    col=col*vHazeT+vHaze;
#else
    vec3 vd=normalize(vWP);
    // From the surface point (C1, centre-relative, above) back along the view ray to where it enters
    // the air, or to the camera if that's inside it. C1 is on the true sphere, not the mesh, whose flat
    // faces sag tens of km inside it on a giant (the haze traced every face as a square grid).
    vec3 C1s=normalize(C1)*uAtR;
    float k=dot(C1s,vd);
    float sAir=k+sqrt(max(k*k-dot(C1s,C1s)+uAtTop*uAtTop,0.0));
    vec3 trans;
    vec3 haze=atInscatterC(C1s-vd*min(sAir,length(vWP)),C1s,L,trans,5);
    col=col*trans+haze;
#endif
  } else {
    float rim=pow(1.0-max(dot(N,V),0.0),3.0);
    col+=uAtmo*uAtmoK*rim*clamp(ndl+0.25,0.0,1.0)*1.1;
  }
  col+=emit;
  gl_FragColor=vec4(col*uExp,1.0);
}
