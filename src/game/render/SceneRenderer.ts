import { AU, FOV, WT } from '../constants';
import type { Game } from '../Game';
import { kelvin } from '../lib/color';
import { mulberry32, rr } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Star, StarSystem, World } from '../types';
import { ATMO_FS, BODY_VS, GLOW_FS, GLOW_VS, PLANET_FS, POINT_FS, POINT_VS, RING_FS, SKYPT_FS, SKYPT_VS, SKY_FS, SKY_VS, STAR_FS } from './shaders';

type Uniforms = Record<string, THREE.IUniform>;

/** Scene objects for one body. `dist` and `pxR` are refreshed every frame. */
export interface BodyView {
  group: THREE.Group;
  mesh: THREE.Mesh;
  atmo?: THREE.Mesh;
  glow?: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  uni?: Uniforms;
  ringUni?: Uniforms;
  dotColor?: THREE.Color;
  dist: number; // m from the ship
  pxR: number; // apparent radius in pixels
}

const MAXDOTS = 256;
const DUST = 700,
  DUSTBOX = 3000;

/**
 * Draws the system around the ship with three.js. The camera sits at the origin and every body
 * is placed relative to the ship, so positions stay precise at astronomical distances. The sky
 * (Milky Way and stars) is a separate scene drawn first with its own camera.
 */
export class SceneRenderer {
  readonly gl: THREE.WebGLRenderer;
  readonly views = new Map<Body, BodyView>();
  private readonly scene = new THREE.Scene();
  private readonly skyScene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 1e21);
  private readonly skyCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  private readonly PR: number;
  private readonly geoHi = new THREE.SphereGeometry(1, 320, 160);
  private readonly geoMid = new THREE.SphereGeometry(1, 96, 48);
  private readonly geoLo = new THREE.SphereGeometry(1, 32, 16);
  private readonly plane = new THREE.PlaneGeometry(2, 2);
  private sysStars: THREE.Points | null = null;
  private readonly dotGeo = new THREE.BufferGeometry();
  private readonly dustGeo = new THREE.BufferGeometry();
  private readonly dust: THREE.Points;
  private readonly dustSeed: [number, number, number][] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.gl.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    this.gl.autoClear = false;
    this.PR = this.gl.getPixelRatio();
    this.buildSky();

    // distant bodies drawn as dots of reflected starlight
    this.dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXDOTS * 3), 3));
    this.dotGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAXDOTS * 3), 3));
    this.dotGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAXDOTS), 1));
    const dots = new THREE.Points(this.dotGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    dots.frustumCulled = false;
    this.scene.add(dots);

    // dust around the ship, so you can feel your speed in normal space
    const g = mulberry32(99);
    for (let i = 0; i < DUST; i++) this.dustSeed.push([g() * DUSTBOX, g() * DUSTBOX, g() * DUSTBOX]);
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));
    this.dustGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));
    this.dustGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(DUST).fill(2.2 * this.PR), 1));
    this.dust = new THREE.Points(this.dustGeo, dots.material);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  resize(W: number, H: number) {
    this.gl.setSize(W, H, false);
    this.camera.aspect = this.skyCam.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.skyCam.updateProjectionMatrix();
  }

  private pointsMaterial() {
    return new THREE.ShaderMaterial({ vertexShader: SKYPT_VS, fragmentShader: SKYPT_FS, uniforms: { uPR: { value: this.PR } }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  }

  /** The Milky Way band and 11,000 background stars. */
  private buildSky() {
    const sky = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false }));
    this.skyScene.add(sky);
    const g = mulberry32(777);
    const N = 11000,
      pos = new Float32Array(N * 3),
      col = new Float32Array(N * 3),
      size = new Float32Array(N);
    const gn = new THREE.Vector3(0.05, 1, 0.12).normalize();
    const v = new THREE.Vector3(),
      tmp = new THREE.Color();
    for (let i = 0; i < N; i++) {
      v.set(g() * 2 - 1, g() * 2 - 1, g() * 2 - 1);
      if (v.lengthSq() > 1 || v.lengthSq() < 1e-4) {
        i--;
        continue;
      }
      v.normalize();
      if (g() < 0.45) {
        // crowd toward the galactic plane
        const b = v.dot(gn);
        v.addScaledVector(gn, -b + b * 0.12 * (g() < 0.5 ? 1 : 0.3)).normalize();
      }
      v.multiplyScalar(90);
      pos.set([v.x, v.y, v.z], i * 3);
      const br = Math.pow(g(), 7);
      const T = g() < 0.1 ? rr(g, 9000, 25000) : g() < 0.4 ? rr(g, 3000, 4500) : rr(g, 4500, 7500);
      tmp.copy(kelvin(T)).lerp(new THREE.Color(1, 1, 1), 0.35).multiplyScalar(0.18 + br * 1.1);
      col.set([tmp.r, tmp.g, tmp.b], i * 3);
      size[i] = 1.6 + br * 3.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.skyScene.add(new THREE.Points(geo, this.pointsMaterial()));
  }

  /** The other star systems as sky points, bright by flux from here. */
  private buildSysStars(cur: StarSystem, systems: StarSystem[]) {
    if (this.sysStars) {
      this.skyScene.remove(this.sysStars);
      this.sysStars.geometry.dispose();
      (this.sysStars.material as THREE.Material).dispose();
    }
    const others = systems.filter((s) => s !== cur);
    const N = others.length,
      pos = new Float32Array(N * 3),
      col = new Float32Array(N * 3),
      size = new Float32Array(N);
    others.forEach((s, i) => {
      const d = s.pos.clone().sub(cur.pos);
      const ly = d.length();
      d.normalize().multiplyScalar(80);
      pos.set([d.x, d.y, d.z], i * 3);
      const f = s.star.L / (ly * ly);
      const k = Math.min(1, 0.35 + 0.3 * Math.log10(1 + f * 400));
      const c = s.star.color.clone().lerp(new THREE.Color(1, 1, 1), 0.25).multiplyScalar(k * 1.3);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = Math.min(10, 2.4 + 2.2 * Math.log10(1 + f * 300));
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    this.sysStars = new THREE.Points(geo, this.pointsMaterial());
    this.skyScene.add(this.sysStars);
  }

  /** Replace the scene contents with a newly loaded system. */
  setSystem(cur: CurrentSystem, systems: StarSystem[]) {
    this.disposeSystem();
    for (const b of cur.bodies) this.views.set(b, b.kind === 'star' ? this.attachStar(b) : this.attachWorld(b, cur.star));
    this.buildSysStars(cur.sys, systems);
  }

  private isShared(geo: THREE.BufferGeometry) {
    return geo === this.geoHi || geo === this.geoMid || geo === this.geoLo || geo === this.plane;
  }

  private disposeSystem() {
    for (const v of this.views.values()) {
      this.scene.remove(v.group);
      v.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.material) (m.material as THREE.Material).dispose();
        if (m.geometry && !this.isShared(m.geometry)) m.geometry.dispose();
      });
      if (v.glow) {
        this.scene.remove(v.glow);
        v.glow.material.dispose();
      }
    }
    this.views.clear();
  }

  private attachStar(b: Star): BodyView {
    const group = new THREE.Group();
    this.scene.add(group);
    const mesh = new THREE.Mesh(this.geoMid, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: STAR_FS, uniforms: { uColor: { value: b.color }, uTime: { value: 0 }, uSeed: { value: b.seed } } }));
    mesh.scale.setScalar(b.radius);
    group.add(mesh);
    const glow = new THREE.Mesh(
      this.plane,
      new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: { uColor: { value: b.color.clone().lerp(new THREE.Color(1, 1, 1), 0.2) }, uI: { value: 1 } }, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    glow.frustumCulled = false;
    this.scene.add(glow);
    return { group, mesh, glow, dist: Infinity, pxR: 0 };
  }

  private attachWorld(b: World, star: Star): BodyView {
    const group = new THREE.Group();
    this.scene.add(group);
    const light = star.pos.clone().sub(b.pos).normalize();
    const tilt = new THREE.Group();
    tilt.quaternion.setFromAxisAngle(new THREE.Vector3(Math.cos(b.seed), 0, Math.sin(b.seed)), b.tilt);
    group.add(tilt);
    const atmo = b.pal.atmo;
    const uni: Uniforms = {
      uType: { value: b.type }, uOct: { value: 5 },
      uA: { value: b.pal.a }, uB: { value: b.pal.b }, uC: { value: b.pal.c }, uD: { value: b.pal.d },
      uAtmo: { value: atmo ? atmo.c : new THREE.Color(0, 0, 0) }, uAtmoK: { value: atmo ? atmo.k * 0.6 : 0 },
      uSea: { value: b.pal.sea }, uSeed: { value: b.seed }, uTime: { value: 0 }, uLight: { value: light },
    };
    const mesh = new THREE.Mesh(this.geoMid, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: PLANET_FS, uniforms: uni }));
    mesh.scale.setScalar(b.radius);
    mesh.rotation.y = b.rot;
    tilt.add(mesh);
    const view: BodyView = { group, mesh, uni, dist: Infinity, pxR: 0 };
    if (atmo) {
      const k = b.type >= WT.GasGiant ? 1.02 : 1.025;
      view.atmo = new THREE.Mesh(
        this.geoMid,
        new THREE.ShaderMaterial({
          vertexShader: BODY_VS, fragmentShader: ATMO_FS, side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
          uniforms: { uAtmo: { value: atmo.c }, uLight: { value: light }, uK: { value: atmo.k }, uEdge: { value: Math.sqrt(1 - 1 / (k * k)) } },
        }),
      );
      view.atmo.scale.setScalar(b.radius * k);
      tilt.add(view.atmo);
    }
    if (b.ring) {
      view.ringUni = { uColor: { value: b.ring.color }, uLight: { value: light }, uPC: { value: new THREE.Vector3() }, uPR: { value: b.radius }, uIn: { value: b.ring.inner }, uOut: { value: b.ring.outer }, uSeed: { value: b.ring.seed } };
      const rm = new THREE.Mesh(new THREE.RingGeometry(b.ring.inner, b.ring.outer, 256, 1), new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: RING_FS, uniforms: view.ringUni, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
      rm.rotation.x = -Math.PI / 2;
      rm.scale.setScalar(b.radius);
      tilt.add(rm);
    }
    view.dotColor = b.pal.a.clone().lerp(b.pal.b, 0.5).lerp(new THREE.Color(1, 1, 1), 0.4);
    return view;
  }

  render(g: Game) {
    const { ship, cur, simTime } = g;
    const { pxPerRad } = g.view;
    const { camera, skyCam, dotGeo, PR, tmp, tmp2 } = this;
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(ship.q);
    camera.updateMatrixWorld();
    skyCam.quaternion.copy(ship.q);
    skyCam.updateMatrixWorld();

    const dPos = dotGeo.attributes.position.array as Float32Array,
      dCol = dotGeo.attributes.aColor.array as Float32Array,
      dSize = dotGeo.attributes.aSize.array as Float32Array;
    let nd = 0;
    const starPos = cur.star.pos;
    for (const b of cur.bodies) {
      const v = this.views.get(b)!;
      const rel = tmp.subVectors(b.pos, ship.pos);
      const d = rel.length();
      v.group.position.copy(rel);
      v.mesh.rotation.y = b.rot;
      v.dist = d;
      const pxR = (b.radius / d) * pxPerRad;
      v.pxR = pxR;
      const geo = pxR > 140 ? this.geoHi : pxR > 14 ? this.geoMid : this.geoLo;
      v.mesh.geometry = geo;
      v.mesh.visible = pxR > 0.6;
      if (v.atmo) {
        v.atmo.geometry = geo;
        v.atmo.visible = pxR > 2;
      }
      if (b.kind === 'star') {
        (v.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = simTime;
        const flux = b.L * (AU / d) * (AU / d);
        const I = Math.min(1.5, Math.max(0.35, 0.95 + 0.2 * Math.log10(flux)));
        const minPx = 16 + 22 * I;
        const s = Math.max(b.radius * 5, (d / pxPerRad) * minPx);
        const glow = v.glow!;
        glow.position.copy(rel);
        glow.quaternion.copy(ship.q);
        glow.scale.setScalar(s);
        glow.material.uniforms.uI.value = I;
        continue;
      }
      const uni = v.uni!;
      uni.uTime.value = simTime;
      uni.uOct.value = Math.max(4, Math.min(13, Math.round(4 + Math.log2(Math.max(pxR, 1) / 30))));
      if (v.ringUni) (v.ringUni.uPC.value as THREE.Vector3).copy(rel);
      // distant bodies as dots of reflected starlight
      if (pxR < 2.5 && nd < MAXDOTS) {
        const dS = b.pos.distanceTo(starPos);
        const toS = tmp2.subVectors(starPos, b.pos).normalize();
        const phase = 0.5 * (1 - toS.dot(rel) / d);
        const dA = d / AU;
        const br = ((6e8 * b.albedo * cur.star.L * (b.radius / dS) ** 2) / (dA * dA)) * (0.15 + phase);
        const a = Math.max(0, Math.min(1, (Math.log10(br) + 3.2) / 3.2)) * (pxR < 1.2 ? 1 : (2.5 - pxR) / 1.3);
        if (a > 0.02) {
          const c = v.dotColor!;
          dPos[nd * 3] = rel.x;
          dPos[nd * 3 + 1] = rel.y;
          dPos[nd * 3 + 2] = rel.z;
          dCol[nd * 3] = c.r * a;
          dCol[nd * 3 + 1] = c.g * a;
          dCol[nd * 3 + 2] = c.b * a;
          dSize[nd] = (2.2 + 2.5 * a) * PR;
          nd++;
        }
      }
    }
    dotGeo.setDrawRange(0, nd);
    dotGeo.attributes.position.needsUpdate = dotGeo.attributes.aColor.needsUpdate = dotGeo.attributes.aSize.needsUpdate = true;

    this.updateDust(g);

    const gl = this.gl;
    gl.clear();
    gl.render(this.skyScene, skyCam);
    gl.clearDepth();
    gl.render(this.scene, camera);
  }

  /** Dust particles wrap around the ship in a box, fading toward its edges. */
  private updateDust(g: Game) {
    const { ship } = g;
    const dust = this.dust;
    dust.visible = ship.mode === 'normal';
    if (!dust.visible) return;
    const p = this.dustGeo.attributes.position.array as Float32Array,
      c = this.dustGeo.attributes.aColor.array as Float32Array;
    const mx = ((ship.pos.x % DUSTBOX) + DUSTBOX) % DUSTBOX,
      my = ((ship.pos.y % DUSTBOX) + DUSTBOX) % DUSTBOX,
      mz = ((ship.pos.z % DUSTBOX) + DUSTBOX) % DUSTBOX;
    const h = DUSTBOX / 2;
    for (let i = 0; i < DUST; i++) {
      const s = this.dustSeed[i];
      const x = ((((s[0] - mx) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h,
        y = ((((s[1] - my) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h,
        z = ((((s[2] - mz) % DUSTBOX) + DUSTBOX) % DUSTBOX) - h;
      p[i * 3] = x;
      p[i * 3 + 1] = y;
      p[i * 3 + 2] = z;
      const f = Math.max(0, 1 - Math.sqrt(x * x + y * y + z * z) / h) * 0.55;
      c[i * 3] = f;
      c[i * 3 + 1] = f * 0.92;
      c[i * 3 + 2] = f * 0.85;
    }
    this.dustGeo.attributes.position.needsUpdate = this.dustGeo.attributes.aColor.needsUpdate = true;
  }

  dispose() {
    this.disposeSystem();
    const dispose = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    };
    this.scene.traverse(dispose);
    this.skyScene.traverse(dispose);
    for (const geo of [this.geoHi, this.geoMid, this.geoLo, this.plane]) geo.dispose();
    this.gl.dispose();
  }
}
