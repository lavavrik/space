varying vec3 vDir;
// 1 for the whole-sky cube bake; the periscope's magnification when baking a zoomed patch, which
// adds the structure the cube map can't hold (see SceneRenderer.updateSkyPatch)
uniform float uZoom;
// unresolved-star cells per radian in a zoomed patch (0: none)
uniform float uCell;
#pragma farlight_noise

// cheap hash of a lattice cell (Dave Hoskins' hash13), fine for the large coordinates of a zoomed patch
float hash13(vec3 p3){ p3=fract(p3*0.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }

// A nebula centred on direction c with angular radius r: domain-warped noise gives it filaments,
// a gaussian falloff its extent, a second noise its dark dust lanes. `outer` colours the cloud,
// `inner` its hot core (e.g. teal O III inside red H-alpha). Baked once into the sky cube map.
vec3 nebula(vec3 d, vec3 c, float r, float seed, vec3 outer, vec3 inner){
  float cosd=dot(d,normalize(c));
  if(cosd<cos(r*3.0)) return vec3(0.0);
  float ang=acos(clamp(cosd,-1.0,1.0));
  // irregular outline: the radius itself wanders with direction
  float rr=r*(0.5+1.0*(fbm(d*(1.4/r)+vec3(seed*5.0),3)*0.5+0.5));
  float fall=exp(-1.2*(ang/rr)*(ang/rr));
  vec3 p=d*(1.7/r)+vec3(seed);
  vec3 w=vec3(fbm(p*0.35+seed,3),fbm(p*0.35+seed+4.1,3),fbm(p*0.35+seed+8.3,3));
  float n=fbm(p*0.7+w*1.6,6)*0.5+0.5;
  // ridged noise: thin bright strands where the field crosses zero
  float ridge=1.0-abs(fbm(p*0.9+w*1.2+seed*2.0,5));
  float fil=0.85*pow(clamp(n,0.0,1.0),1.8)+0.35*pow(clamp(ridge,0.0,1.0),10.0);
  float lanes=1.0-0.7*smoothstep(0.55,0.8,fbm(p*0.8+w+seed*3.1,5)*0.5+0.5);
  float core=pow(fall,3.0)*n;
  return (outer*fall*fil*2.4+inner*core*1.4)*lanes;
}

// A small planetary nebula: a glowing shell, brighter at the rim, red outside and teal within.
vec3 ringNebula(vec3 d, vec3 c, float r){
  float cosd=dot(d,normalize(c));
  if(cosd<cos(r*2.0)) return vec3(0.0);
  float x=acos(clamp(cosd,-1.0,1.0))/r;
  float shell=exp(-pow((x-0.75)/0.22,2.0))*(0.8+0.4*(fbm(d*(40.0/r),3)*0.5+0.5));
  float fill=exp(-x*x*2.5);
  return vec3(0.55,0.12,0.18)*shell*0.5+vec3(0.1,0.35,0.34)*fill*0.35;
}

void main(){
  vec3 d=normalize(vDir);
  vec3 gn=normalize(vec3(0.05,1.0,0.12));
  vec3 gc=normalize(vec3(1.0,-0.05,0.25));
  float b=dot(d,gn);
  float c=max(dot(d,gc),0.0);
  float n1=fbm(d*3.0,5)*0.5+0.5;
  float n2=fbm(d*9.0+3.0,4)*0.5+0.5;
  float band=exp(-b*b/(0.012*(1.0+c*3.0)));
  float wide=exp(-b*b/0.1);
  float dust=smoothstep(0.48,0.72,fbm(d*7.0+7.0,5)*0.5+0.5)*exp(-b*b/0.003);
  float i=band*(0.07+0.2*n1*n2)*(1.0+3.0*pow(c,3.0))+wide*0.025*n1;
  i*=1.0-dust*0.85;
  if(uZoom>1.5){
    // zoomed: finer glow structure and dust lanes at the new scale
    // broad light and dark patches, a fine texture, and thin dark dust lanes that only show up in
    // some regions (a lattice of lanes everywhere looked like cracked glass)
    float broad=fbm(d*(4.0*uZoom),3)*0.5+0.5;
    float fine=fbm(d*(20.0*uZoom),4)*0.5+0.5;
    float rid=1.0-abs(fbm(d*(10.0*uZoom)+5.0,4));
    float region=smoothstep(0.5,0.72,fbm(d*(2.5*uZoom)+2.0,3)*0.5+0.5);
    float fdust=pow(clamp(rid,0.0,1.0),10.0)*region*exp(-b*b/0.008);
    i*=(0.5+1.0*broad)*(0.9+0.2*fine)*(1.0-fdust*0.5);
  }
  vec3 col=mix(vec3(0.55,0.62,0.85),vec3(1.0,0.84,0.62),clamp(c*1.2+n2*0.3-0.2,0.0,1.0))*i;
  float neb=pow(max(fbm(d*2.4+11.0,4),0.0),2.0);
  col+=neb*vec3(0.05,0.012,0.035);
  float neb2=pow(max(fbm(d*1.8+31.0,4),0.0),2.0);
  col+=neb2*vec3(0.008,0.02,0.04);
  // Nebulae, all well off the galactic belt (latitudes ~35–55°) so the Milky Way stays clean:
  // four clouds of mixed kinds (a red H-alpha emission cloud with a teal O III core, two blue
  // reflection nebulae, a violet one where both mix) and two small planetary rings. Kept faint
  // (NEB_ALPHA, RING_ALPHA) so they tint the sky rather than dominate it.
  const float NEB_ALPHA=0.5, RING_ALPHA=0.3;
  vec3 neb3=nebula(d,gn*0.75+vec3(0.6,0.0,-0.5),0.16,1.0,vec3(0.62,0.1,0.2),vec3(0.1,0.42,0.4)*0.8);
  neb3+=nebula(d,-gn*0.65+vec3(-0.5,0.0,0.65),0.12,23.0,vec3(0.16,0.26,0.6),vec3(0.35,0.45,0.8));
  neb3+=nebula(d,gn*0.8+vec3(0.5,0.0,0.55),0.1,41.0,vec3(0.36,0.16,0.55),vec3(0.55,0.35,0.8));
  neb3+=nebula(d,-gn*0.7+vec3(0.7,0.0,-0.4),0.14,57.0,vec3(0.12,0.32,0.58),vec3(0.3,0.55,0.8));
  col+=neb3*NEB_ALPHA;
  vec3 rings=ringNebula(d,gn*0.9+vec3(-0.75,0.0,-0.45),0.035)+ringNebula(d,-gn*0.9+vec3(-0.3,0.0,-0.8),0.03);
  col+=rings*RING_ALPHA;
  if(uCell>0.0){
    // the band resolves into faint stars: one candidate per lattice cell, more of them where the
    // band is bright, each a small soft dot at a random spot in its cell
    vec3 p=d*uCell, cell=floor(p), f=fract(p)-0.5;
    float dens=clamp(0.04+i*5.0,0.0,0.6);
    if(hash13(cell)<dens){
      vec3 off=vec3(hash13(cell+1.3),hash13(cell+2.7),hash13(cell+4.1))-0.5;
      vec3 q=f-off*0.6;
      float r2=dot(q,q)-pow(dot(q,d),2.0); // distance across the line of sight
      float br=0.08+0.6*pow(hash13(cell+7.7),4.0);
      col+=mix(vec3(1.0,0.85,0.7),vec3(0.75,0.85,1.0),hash13(cell+9.1))*br*exp(-r2*30.0);
    }
  }
  gl_FragColor=vec4(col,1.0);
}
