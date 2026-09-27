// A star in the sky: a soft round point. vC is its colour times intensity and may exceed 1; the
// overflow bleeds into the other channels as white, strongest in the centre, so bright stars get
// a white core inside a halo of their own colour and dim ones keep their pure hue (see skyColor).
varying vec3 vC;
uniform float uSkyExp; // SKY_K × exposure (render/exposure.ts)
void main(){
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * 4.0) * (1.0 - smoothstep(0.85, 1.0, r));
  vec3 c = vC * a * 1.6; // stars shine brighter than the Milky Way behind them
  float m = max(c.r, max(c.g, c.b));
  c += vec3(max(0.0, m - 0.75) * 0.8);
  gl_FragColor = vec4(c * uSkyExp, 1.0);
}
