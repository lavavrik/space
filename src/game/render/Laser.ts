/*
 * The mining laser on screen (sim/laser.ts):
 *   - the beam: a ribbon from the emitter (under the nose) to where it hits or its range, facing the
 *     camera, never thinner than a couple of pixels, bright at its core;
 *   - where it hits: a white-hot spot, flickering;
 *   - the plume: ice boiling off the rock, a spray of fading specks thrown out along the surface's
 *     normal (drawn relative to the hit point, so they ride along with the rock).
 * Display-referred (added after the exposure, like the signal lights: render/exposure.ts), and left
 * out of the exposure meter.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';

const BEAM_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aSide; attribute float aAlong;
varying float vSide; varying float vAlong;
void main(){
  vSide = aSide; vAlong = aAlong;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const BEAM_FS = `
#include <logdepthbuf_pars_fragment>
uniform float uI; uniform float uTime;
varying float vSide; varying float vAlong;
void main(){
  #include <logdepthbuf_fragment>
  float core = exp(-vSide * vSide * 18.0), glow = exp(-vSide * vSide * 3.0) * 0.35;
  float shimmer = 0.85 + 0.15 * sin(vAlong * 0.08 - uTime * 40.0);
  vec3 c = vec3(1.0, 0.95, 0.9) * core + vec3(1.0, 0.35, 0.15) * glow;
  gl_FragColor = vec4(c * uI * shimmer, 0.0);
}`;
const DOT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor; attribute float aSize;
varying vec3 vC;
void main(){
  vC = aColor;
  gl_PointSize = aSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const DOT_FS = `
#include <logdepthbuf_pars_fragment>
varying vec3 vC;
void main(){
  #include <logdepthbuf_fragment>
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-r * r * 3.5) * (1.0 - smoothstep(0.8, 1.0, r));
  gl_FragColor = vec4(vC * a, 0.0);
}`;
/** Colour adds; alpha 0 keeps it out of the exposure meter (render/hdr.ts). */
const ADD = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor } as const;

/** The emitter, in the ship's axes (m): under the nose, a little ahead of the camera. */
const MUZZLE = new THREE.Vector3(0, -4, -6);
/** Plume specks. */
const PUFFS = 90,
  PUFF_LIFE = 2.5;

interface Puff {
  off: THREE.Vector3; // from the rock's centre (m): the plume stays on the rock where it was hit, however the beam wanders
  vel: THREE.Vector3; // m/s, relative to the rock
  age: number;
  size: number;
}

export class LaserView {
  readonly group = new THREE.Group();
  private readonly beam: THREE.Mesh;
  private readonly beamUni = { uI: { value: 1 }, uTime: { value: 0 } };
  private readonly dots: THREE.Points;
  private readonly puffs: Puff[] = [];
  private spawn = 0;
  private lastT = 0;
  private hitId = '';

  constructor() {
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
    bg.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array([-1, 1, -1, 1]), 1));
    bg.setAttribute('aAlong', new THREE.BufferAttribute(new Float32Array(4), 1));
    bg.setIndex([0, 1, 2, 2, 1, 3]);
    this.beam = new THREE.Mesh(bg, new THREE.ShaderMaterial({ vertexShader: BEAM_VS, fragmentShader: BEAM_FS, uniforms: this.beamUni, transparent: true, depthWrite: false, side: THREE.DoubleSide, ...ADD }));
    this.beam.frustumCulled = false;
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array((PUFFS + 1) * 3), 3));
    dg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array((PUFFS + 1) * 3), 3));
    dg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(PUFFS + 1), 1));
    this.dots = new THREE.Points(dg, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, transparent: true, depthWrite: false, ...ADD }));
    this.dots.frustumCulled = false;
    this.group.add(this.beam, this.dots);
    this.group.visible = false;
  }

  /** `pxScale`: device pixels per CSS pixel (for point sizes). */
  update(g: Game, pxScale: number) {
    const L = g.laser;
    const dt = Math.max(0, Math.min(0.1, g.simTime - this.lastT));
    this.lastT = g.simTime;
    if (!L.on || !L.end) {
      this.group.visible = false;
      this.puffs.length = 0;
      return;
    }
    this.group.visible = true;
    const { ship } = g;
    const w = g.frameBody;
    // camera-relative ends
    const a = MUZZLE.clone().applyQuaternion(ship.q);
    const b = L.end.clone().add(w.pos).sub(ship.pos);
    const len = b.distanceTo(a);
    // a ribbon facing the camera (at the origin), at least ~2 px wide at each end
    const dir = b.clone().sub(a).normalize();
    const side = (p: THREE.Vector3) => {
      const s = new THREE.Vector3().crossVectors(dir, p).normalize();
      const minW = (p.length() * 2.5) / g.view.pxPerRad;
      return s.multiplyScalar(Math.max(0.35, minW));
    };
    const sa = side(a),
      sb = side(b);
    const pos = this.beam.geometry.attributes.position.array as Float32Array;
    pos.set([a.x - sa.x, a.y - sa.y, a.z - sa.z, a.x + sa.x, a.y + sa.y, a.z + sa.z, b.x - sb.x, b.y - sb.y, b.z - sb.z, b.x + sb.x, b.y + sb.y, b.z + sb.z]);
    (this.beam.geometry.attributes.aAlong.array as Float32Array).set([0, 0, len, len]);
    this.beam.geometry.attributes.position.needsUpdate = this.beam.geometry.attributes.aAlong.needsUpdate = true;
    const now = performance.now() / 1000;
    this.beamUni.uTime.value = now;
    this.beamUni.uI.value = L.hit ? 1.2 : 0.6;

    // the plume: specks thrown off along the rock's surface normal where it's hit
    const dp = this.dots.geometry.attributes.position.array as Float32Array,
      dc = this.dots.geometry.attributes.aColor.array as Float32Array,
      ds = this.dots.geometry.attributes.aSize.array as Float32Array;
    let n = 0;
    if (L.hit) {
      if (L.hit.id !== this.hitId) this.puffs.length = 0;
      this.hitId = L.hit.id;
      // the hot spot
      const d = b.length();
      const spot = Math.max(8, Math.min(60, (L.hit.size * 0.25 * g.view.pxPerRad) / d));
      dp.set([b.x, b.y, b.z], 0);
      const f = 0.8 + 0.2 * Math.sin(now * 37) * Math.sin(now * 23);
      dc.set([1.6 * f, 1.3 * f, 1.0 * f], 0);
      ds[0] = spot * pxScale;
      n = 1;
      this.spawn += dt * 40;
      const nrm = L.hit.normal;
      while (this.spawn >= 1) {
        this.spawn -= 1;
        const v = nrm.clone().multiplyScalar(15 + Math.random() * 35);
        v.add(new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(25));
        const p: Puff = { off: L.end.clone().sub(L.hit.center), vel: v, age: 0, size: 2 + Math.random() * 3 };
        if (this.puffs.length >= PUFFS) this.puffs.shift();
        this.puffs.push(p);
      }
    } else this.puffs.length = 0;
    for (const p of this.puffs) {
      p.age += dt;
      p.off.addScaledVector(p.vel, dt);
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) if (this.puffs[i].age > PUFF_LIFE) this.puffs.splice(i, 1);
    // the rock's centre, camera-relative (the specks ride along with it)
    const c = L.hit ? L.hit.center.clone().add(w.pos).sub(ship.pos) : b;
    for (const p of this.puffs) {
      const x = c.x + p.off.x,
        y = c.y + p.off.y,
        z = c.z + p.off.z;
      const k = 1 - p.age / PUFF_LIFE;
      const dist = Math.hypot(x, y, z);
      dp.set([x, y, z], n * 3);
      dc.set([0.22 * k, 0.28 * k, 0.34 * k], n * 3); // ice vapour, catching the light as it cools
      ds[n] = Math.max(2, Math.min(40, ((p.size * (1 + p.age)) * g.view.pxPerRad) / dist)) * pxScale;
      n++;
    }
    this.dots.geometry.setDrawRange(0, n);
    for (const k of ['position', 'aColor', 'aSize']) this.dots.geometry.attributes[k].needsUpdate = true;
  }

  dispose() {
    this.beam.geometry.dispose();
    (this.beam.material as THREE.Material).dispose();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
  }
}
