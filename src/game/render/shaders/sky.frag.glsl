varying vec3 vDir;
#pragma farlight_noise
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
  gl_FragColor=vec4(col,1.0);
}
