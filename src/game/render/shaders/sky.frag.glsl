varying vec3 vDir;
#pragma farlight_noise

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
  vec3 col=mix(vec3(0.55,0.62,0.85),vec3(1.0,0.84,0.62),clamp(c*1.2+n2*0.3-0.2,0.0,1.0))*i;
  float neb=pow(max(fbm(d*2.4+11.0,4),0.0),2.0);
  col+=neb*vec3(0.05,0.012,0.035);
  float neb2=pow(max(fbm(d*1.8+31.0,4),0.0),2.0);
  col+=neb2*vec3(0.008,0.02,0.04);
  // Nebulae, all well off the galactic belt (latitudes ~35–55°) so the Milky Way stays clean:
  // three blue reflection nebulae (dust lit by hot stars, each a slightly different hue) and two
  // small planetary rings. Kept faint (NEB_ALPHA, RING_ALPHA) so they tint the sky rather than
  // dominate it.
  const float NEB_ALPHA=0.5, RING_ALPHA=0.3;
  vec3 neb3=nebula(d,-gn*0.65+vec3(-0.5,0.0,0.65),0.12,23.0,vec3(0.16,0.26,0.6),vec3(0.35,0.45,0.8));
  neb3+=nebula(d,gn*0.8+vec3(0.5,0.0,0.55),0.1,41.0,vec3(0.22,0.22,0.62),vec3(0.45,0.42,0.85));
  neb3+=nebula(d,-gn*0.7+vec3(0.7,0.0,-0.4),0.14,57.0,vec3(0.12,0.32,0.58),vec3(0.3,0.55,0.8));
  col+=neb3*NEB_ALPHA;
  vec3 rings=ringNebula(d,gn*0.9+vec3(-0.75,0.0,-0.45),0.035)+ringNebula(d,-gn*0.9+vec3(-0.3,0.0,-0.8),0.03);
  col+=rings*RING_ALPHA;
  gl_FragColor=vec4(col,1.0);
}
