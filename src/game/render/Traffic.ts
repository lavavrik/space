/*
 * Other ships (sim/traffic.ts) on screen: a 60 m hull pointing where it's going, lit by the star, a
 * marker dot that stays a few pixels across from any distance (cyan in FTL), an engine glow while
 * it manoeuvres, and in FTL a long trail of where it's been, fading with age. Positions are
 * camera-relative (world − ship), like the rest of the scene.
 */
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { TRAIL_MAX_POINTS, TRAIL_S, trailPoints, type Npc } from '../sim/traffic';

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

/** The FTL trail: a line whose brightness falls with each point's age. */
const TRAIL_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aAge;
uniform float uTrailS;
varying float vA;
void main(){
  float f = clamp(1.0 - aAge / uTrailS, 0.0, 1.0);
  vA = f * f;
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
  hull: THREE.Mesh;
  trail: THREE.Line;
  trailPos: Float32Array;
  trailAge: Float32Array;
}

export class TrafficView {
  readonly group = new THREE.Group();
  private readonly ships: ShipView[] = [];
  private readonly hullGeo = new THREE.CylinderGeometry(6, 6, 60, 12).rotateX(Math.PI / 2); // along z
  private readonly hullMat: THREE.ShaderMaterial;
  private readonly trailMat: THREE.ShaderMaterial;
  private readonly dots: THREE.Points;
  private readonly light = new THREE.Vector3();
  private readonly tmp = new THREE.Vector3();

  constructor() {
    this.hullMat = new THREE.ShaderMaterial({ vertexShader: HULL_VS, fragmentShader: HULL_FS, uniforms: { uLight: { value: this.light } } });
    this.trailMat = new THREE.ShaderMaterial({ vertexShader: TRAIL_VS, fragmentShader: TRAIL_FS, uniforms: { uTrailS: { value: TRAIL_S } }, transparent: true, depthWrite: false, ...ADD });
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 2 * 3), 3));
    dg.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 2 * 3), 3));
    dg.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX_SHIPS * 2), 1));
    this.dots = new THREE.Points(dg, new THREE.ShaderMaterial({ vertexShader: DOT_VS, fragmentShader: DOT_FS, transparent: true, depthWrite: false, ...ADD }));
    this.dots.frustumCulled = false;
    this.group.add(this.dots);
  }

  private view(i: number) {
    let v = this.ships[i];
    if (!v) {
      const tg = new THREE.BufferGeometry();
      const trailPos = new Float32Array(TRAIL_MAX_POINTS * 3),
        trailAge = new Float32Array(TRAIL_MAX_POINTS);
      tg.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
      tg.setAttribute('aAge', new THREE.BufferAttribute(trailAge, 1));
      v = { hull: new THREE.Mesh(this.hullGeo, this.hullMat), trail: new THREE.Line(tg, this.trailMat), trailPos, trailAge };
      v.hull.frustumCulled = false;
      v.trail.frustumCulled = false;
      this.group.add(v.hull, v.trail);
      this.ships[i] = v;
    }
    return v;
  }

  update(g: Game, pxScale: number) {
    const { ship, simTime } = g;
    this.light.subVectors(g.cur.star.pos, ship.pos).normalize();
    const dp = this.dots.geometry.attributes.position.array as Float32Array,
      dc = this.dots.geometry.attributes.aColor.array as Float32Array,
      ds = this.dots.geometry.attributes.aSize.array as Float32Array;
    let nd = 0;
    const npcs: Npc[] = g.traffic.slice(0, MAX_SHIPS);
    npcs.forEach((npc, i) => {
      const v = this.view(i);
      const rel = this.tmp.subVectors(npc.pos, ship.pos);
      // hull: nose along its motion (or toward where it's going)
      v.hull.visible = rel.length() < 200e3;
      if (v.hull.visible) {
        v.hull.position.copy(rel);
        const dir = npc.vel.lengthSq() > 1 ? npc.vel : npc.to ? npc.to.pos.clone().sub(npc.pos) : null;
        if (dir) v.hull.lookAt(rel.clone().add(dir.clone().normalize()));
      }
      // marker, and an engine glow behind it while manoeuvring or in FTL
      const ftl = npc.phase === 'ftl';
      dp.set([rel.x, rel.y, rel.z], nd * 3);
      dc.set(ftl ? [0.5, 0.9, 1.0] : [0.85, 0.85, 0.8], nd * 3);
      ds[nd++] = (ftl ? 5 : 3.5) * pxScale;
      if (npc.phase !== 'linger' && npc.vel.lengthSq() > 1) {
        const back = rel.clone().addScaledVector(npc.vel.clone().normalize(), -35);
        dp.set([back.x, back.y, back.z], nd * 3);
        dc.set(ftl ? [0.6, 0.95, 1.4] : [1.4, 0.8, 0.4], nd * 3);
        ds[nd++] = (ftl ? 9 : 6) * pxScale;
      }
      // the trail
      const n = trailPoints(npc, ship.pos, simTime, { pos: v.trailPos, age: v.trailAge });
      v.trail.visible = n > 1;
      v.trail.geometry.setDrawRange(0, n);
      v.trail.geometry.attributes.position.needsUpdate = v.trail.geometry.attributes.aAge.needsUpdate = true;
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
    this.hullGeo.dispose();
    this.hullMat.dispose();
    this.trailMat.dispose();
    this.dots.geometry.dispose();
    (this.dots.material as THREE.Material).dispose();
  }
}
