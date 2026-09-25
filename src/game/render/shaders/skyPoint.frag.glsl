varying vec3 vC; void main(){ float r=length(gl_PointCoord-0.5)*2.0; float a=exp(-r*r*4.0)*(1.0-smoothstep(0.85,1.0,r)); gl_FragColor=vec4(vC*a,1.0); }
