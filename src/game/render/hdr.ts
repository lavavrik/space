/*
 * The HDR frame (render/exposure.ts has the why). The scene is drawn into `target`, a 4× MSAA
 * half-float buffer, already multiplied by the exposure; finish() then
 *   1. shrinks it 8× and 8× again (16 bilinear taps per pixel each time, so every source pixel
 *      counts) into a small float image for the meter, weighting each pixel by its alpha: the
 *      share of it that's physical light (display-referred signal lights write less than 1),
 *   2. hands that to the auto-exposure (read back asynchronously), and
 *   3. tone-maps the frame to the screen: linear up to 0.8, then a soft shoulder toward 1, per
 *      channel, so over-bright light rolls off to white instead of clipping flat.
 */
import { THREE } from '../lib/three';
import type { AutoExposure } from './exposure';

const QUAD_VS =
  'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

const DOWN_FS = `
uniform sampler2D uSrc; uniform vec2 uTexel; varying vec2 vUv;
void main(){
  vec3 s = vec3(0.0);
  for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) {
    vec4 t = texture2D(uSrc, vUv + vec2(float(x) * 2.0 - 3.0, float(y) * 2.0 - 3.0) * uTexel);
    s += t.rgb * clamp(t.a, 0.0, 1.0); // alpha: the physical share (signal lights are masked out)
  }
  gl_FragColor = vec4(min(s / 16.0, vec3(6e4)), 1.0);
}`;

const TONE_FS = `
uniform sampler2D uSrc; varying vec2 vUv;
void main(){
  vec3 c = max(texture2D(uSrc, vUv).rgb, vec3(0.0));
  vec3 s = 0.8 + 0.2 * (1.0 - exp(-(c - 0.8) / 0.2));
  gl_FragColor = vec4(mix(c, s, step(0.8, c)), 1.0);
}`;

export class HdrTarget {
  readonly target: THREE.WebGLRenderTarget;
  private readonly small: THREE.WebGLRenderTarget;
  private readonly meterRT: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly quad: THREE.Mesh;
  private readonly down: THREE.ShaderMaterial;
  private readonly tone: THREE.ShaderMaterial;

  constructor(private readonly gl: THREE.WebGLRenderer) {
    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
    };
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 4,
    });
    this.small = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      type: THREE.HalfFloatType,
    });
    this.meterRT = new THREE.WebGLRenderTarget(1, 1, {
      ...opts,
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.down = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS,
      fragmentShader: DOWN_FS,
      uniforms: {
        uSrc: { value: null },
        uTexel: { value: new THREE.Vector2() },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.tone = new THREE.ShaderMaterial({
      vertexShader: QUAD_VS,
      fragmentShader: TONE_FS,
      uniforms: { uSrc: { value: this.target.texture } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.down);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    this.resize();
  }

  /** Match the drawing buffer (call after the renderer's size or pixel ratio changes). */
  resize() {
    const s = this.gl.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(1, s.x),
      h = Math.max(1, s.y);
    this.target.setSize(w, h);
    this.small.setSize(Math.ceil(w / 8), Math.ceil(h / 8));
    this.meterRT.setSize(Math.ceil(w / 64), Math.ceil(h / 64));
  }

  /** Meter, adapt and tone-map the frame just drawn into `target`. */
  finish(exposure: AutoExposure) {
    const gl = this.gl;
    this.pass(this.down, this.target, this.small);
    this.pass(this.down, this.small, this.meterRT);
    exposure.update(gl, this.meterRT);
    this.quad.material = this.tone;
    gl.setRenderTarget(null);
    gl.render(this.scene, this.cam);
  }

  private pass(
    mat: THREE.ShaderMaterial,
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
  ) {
    mat.uniforms.uSrc.value = src.texture;
    (mat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
    this.quad.material = mat;
    this.gl.setRenderTarget(dst);
    this.gl.render(this.scene, this.cam);
  }

  dispose() {
    for (const rt of [this.target, this.small, this.meterRT]) rt.dispose();
    this.down.dispose();
    this.tone.dispose();
    this.quad.geometry.dispose();
  }
}
