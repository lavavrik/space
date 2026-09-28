/*
 * Other ships (sim/traffic.ts) on screen, and your own FTL trail:
 *   - a small procedural model (hull, nose, cockpit, twin engine pods, a fin), ~60 m long, pointing
 *     where it's going and lit by the star, drawn within 200 km;
 *   - a marker dot a few pixels across from any distance (cyan in FTL);
 *   - its engines: a glow at the tail while it thrusts (orange; blue in FTL), a smaller one at the
 *     nose while it brakes;
 *   - in FTL a trail streaming behind it: a line along its motion, as long as TRAIL_S seconds of
 *     travel at its speed (up to 0.5 AU), bright at the ship and fading to nothing, which pulls in
 *     after drop-out; your ship gets one too;
 *   - a flash as it enters or leaves FTL.
 * Positions are camera-relative (world − ship), like the rest of the scene.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { FLASH_S, easeTrail, type Npc } from '../sim/traffic';

const MAX_SHIPS = 16;

const HULL_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN;
void main(){
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const HULL_FS = `
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight;
varying vec3 vN;
void main(){
  #include <logdepthbuf_fragment>
  float d = max(dot(normalize(vN), uLight), 0.0);
  gl_FragColor = vec4(vec3(0.62, 0.64, 0.68) * (0.04 + 0.6 * d), 1.0);
}`;

/** Points with a fixed pixel size (aSize) and colour (aColor): markers and engine glows. */
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

/** The FTL trail: a line from the ship (aFade 1) back to its tail (0). */
const TRAIL_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aFade;
varying float vA;
void main(){
  vA = aFade * aFade;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
const TRAIL_FS = `
#include <logdepthbuf_pars_fragment>
varying float vA;
void main(){
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(vec3(0.45, 0.85, 1.0) * vA * 0.9, 0.0);
}`;

// additive colour; alpha (0) keeps them out of the exposure meter (render/hdr.ts)
const ADD = { blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor } as const;

interface ShipView {
  hull: THREE.Object3D;
  trail: THREE.Line;
}

/** A trail line: two points, the ship (fade 1) and the tail (fade 0). */
function trailLine(mat: THREE.Material) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  g.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array([1, 0]), 1));
  const l = new THREE.Line(g, mat);
  l.frustumCulled = false;
  return l;
}

/** Point a trail line from `head` (camera-relative) back along `dir` for L metres. */
function setTrail(l: THREE.Line, head: THREE.Vector3, dir: THREE.Vector3, L: number) {
  const p = l.geometry.attributes.position.array as Float32Array;
  p[0] = head.x;
  p[1] = head.y;
  p[2] = head.z;
  p[3] = head.x + dir.x * L;
  p[4] = head.y + dir.y * L;
  p[5] = head.z + dir.z * L;
  l.geometry.attributes.position.needsUpdate = true;
  l.visible = L > 1;
}

/** The ship model: meshes sharing one material, nose along +z (Object3D.lookAt points +z). */
function shipModel(mat: THREE.Material) {
  const m = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    m.add(mesh);
  };
  add(new THREE.CylinderGeometry(5, 6, 44, 14).rotateX(Math.PI / 2), 0, 0, 0); // hull
  add(new THREE.ConeGeometry(5, 12, 14).rotateX(Math.PI / 2), 0, 0, 28); // nose
  add(new THREE.BoxGeometry(4, 2.5, 8), 0, 5.2, 16); // cockpit
  for (const x of [-8, 8]) {
    add(new THREE.CylinderGeometry(2.4, 2.8, 20, 10).rotateX(Math.PI / 2), x, -1, -14); // engine pod
    add(new THREE.BoxGeometry(4.5, 0.8, 6), x / 2, -1, -12); // pylon
  }
  add(new THREE.BoxGeometry(0.8, 9, 10), 0, 8, -17); // fin
  return m;
}

export class TrafficView {
  readonly group = new THREE.Group();
  private readonly ships: ShipView[] = [];
  private readonly hullMat: THREE.ShaderMaterial;
  private readonly model: THREE.Group;
  private readonly own: THREE.Line; // your ship's trail
  private ownL = 0;
  private lastSim = 0;
  private readonly trailMat: THREE.ShaderMaterial;
  private readonly dots: THREE.Points;
  private readonly light = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor() {
    this.hullMat = new THREE.ShaderMaterial({ vertexShader: HULL_VS, fragmentShader: HULL_FS, uniforms: { uLight: { value: this.light } } });
    this.trailMat = new THREE.ShaderMaterial({ vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, transparent: true, depthWrite: false, ...ADD });
    this.model = shipModel(this.hullMat);
    this.own = trailLine(this.trailMat);
    this.group.add(this.own);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 3 * 3), 3));
    dg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 3 * 3), 3));
    dg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 3), 1));
    this.dots = new THREE.Points(dg, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, transparent: true, depthWrite: false, ...ADD }));
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
  }

  private view(i: number) {
    let v = this.ships[i];
    if (!v) {
      v = { hull: this.model.clone(), trail: trailLine(this.trailMat) };
      this.group.add(v.hull, v.trail);
      this.ships[i] = v;
    }
    return v;
  }

  update(g: Game, pxScale: number) {
    const { ship, simTime } = g;
    const dt = Math.max(0, Math.min(1, simTime - this.lastSim));
    this.lastSim = simTime;
    // your own trail, streaming back from just behind the camera along your course
    this.ownL = easeTrail(this.ownL, ship.mode === 'ftl' && !g.jump ? ship.ftlSpeed : 0, dt);
    setTrail(this.own, this.tmp.copy(ship.travelDir).multiplyScalar(-80), this.tmp2.copy(ship.travelDir).negate(), this.ownL);
    this.light.subVectors(g.cur.star.pos, ship.pos).normalize();
    const dp = this.dots.geometry.attributes.position.array as Float32Array,
      dc = this.dots.geometry.attributes.aColor.array as Float32Array,
      ds = this.dots.geometry.attributes.aSize.array as Float32Array;
    let nd = 0;
    const npcs: Npc[] = g.traffic.slice(0, MAX_SHIPS);
    npcs.forEach((npc, i) => {
      const v = this.view(i);
      const rel = this.tmp.subVectors(npc.pos, ship.pos);
      // hull: its own attitude (sim/traffic.ts turns it like a pilot would)
      v.hull.visible = rel.length() < 200e3;
      if (v.hull.visible) {
        v.hull.position.copy(rel);
        v.hull.quaternion.copy(npc.q);
      }
      // marker, and the engines: main at the tail while thrusting, retro at the nose while braking
      const ftl = npc.phase === 'ftl';
      dp.set([rel.x, rel.y, rel.z], nd * 3);
      dc.set(ftl ? [0.5, 0.9, 1.0] : [0.85, 0.85, 0.8], nd * 3);
      ds[nd++] = (ftl ? 5 : 3.5) * pxScale;
      if (npc.thrust !== 0) {
        const nose = this.tmp2.set(0, 0, 1).applyQuaternion(npc.q);
        const at = rel.clone().addScaledVector(nose, npc.thrust > 0 ? -36 : 34);
        dp.set([at.x, at.y, at.z], nd * 3);
        dc.set(ftl ? [0.6, 0.95, 1.4] : npc.thrust > 0 ? [1.4, 0.8, 0.4] : [1.0, 0.7, 0.45], nd * 3);
        ds[nd++] = (ftl ? 9 : npc.thrust > 0 ? 6 : 4) * pxScale;
      }
      // the flash of entering or leaving FTL: a burst that swells and fades
      const fu = (simTime - npc.flashAt) / FLASH_S;
      if (fu >= 0 && fu < 1) {
        const k = (1 - fu) * (1 - fu) * 2.5;
        dp.set([rel.x, rel.y, rel.z], nd * 3);
        dc.set([0.8 * k, 0.95 * k, 1.2 * k], nd * 3);
        ds[nd++] = (14 + 110 * Math.sqrt(fu)) * pxScale;
      }
      // the trail
      setTrail(v.trail, rel, npc.trailDir, npc.trailL);
    });
    for (let i = npcs.length; i < this.ships.length; i++) {
      this.ships[i].hull.visible = false;
      this.ships[i].trail.visible = false;
    }
    this.dots.geometry.setDrawRange(0, nd);
    for (const a of ['position', 'aColor', 'aSize']) this.dots.geometry.attributes[a].needsUpdate = true;
  }

  dispose() {
    for (const v of this.ships) v.trail.geometry.dispose();
    this.own.geometry.dispose();
    this.model.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.hullMat.dispose();
    this.trailMat.dispose();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
  }
}
