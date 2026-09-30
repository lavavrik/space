import { AU, FOV, WT } from '../constants';
import type { Game } from '../Game';
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import type { Body, CurrentSystem, Star, StarSystem, Station, World } from '../types';
import { orbitPreview } from '../sim/planner';
import { HyperspaceView } from './Hyperspace';
import { createNoiseTexture } from '../lib/noise3d';
import { skyColor, skyLook } from '../sim/hyperspace';
import { CORRIDOR_GROW, CORRIDOR_M, corridorGeometry, corridorLights, hullGeometry, interiorGeometry } from './stationMesh';
import { AUTO_EXPOSURE, AutoExposure, CITY_K, FLOOD_K, HEAD_K, INT_K, MAX_EXP, SKY_EXP_P, SKY_K, STAR_EXP_P, WINDOW_K } from './exposure';
import { HdrTarget } from './hdr';
import { TerrainView } from './Terrain';
import { TrafficView } from './Traffic';
import { RingField } from './RingField';
import { hasCraters, reliefAmp, terrainOffsets, worldQuat } from '../sim/terrain';
import { atmoOf } from '../sim/atmosphere';
import { PAD_R, padLocal, stationQuat } from '../sim/stationGeom';
import { SKY_PAD_COUNT, skyPadLocal } from '../sim/skyGeom';
import { LaserView } from './Laser';
import { skyStationGeometry } from './skyMesh';
import { occluder } from '../sim/sight';
import { populated } from '../sim/population';
import { ATMO_FS, BODY_VS, GLOW_FS, GLOW_VS, PLANET_FS, PLANET_VS, POINT_FS, POINT_VS, RING_FS, SKYPT_FS, SKYPT_VS, SKY_BAKE_FS, SKY_CUBE_FS, SKY_FS, SKY_VS, STAR_FS, STATION_FS, SKY_STATION_FS, STATION_INTERIOR_FS, CLOUD_BAKE_FS, CLOUD_FS, CORRIDOR_FS, CORRIDOR_LIGHT_FS, CORRIDOR_LIGHT_VS } from './shaders';
import { slotUser } from '../sim/control';
import type { GameRenderer } from './api';

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
  light?: THREE.Vector3; // direction to the star, shared by the surface, atmosphere and ring uniforms
  /** The cloud layer (worlds with weather), and its baked pattern (a cube map in the world's frame). */
  clouds?: THREE.Mesh;
  cloudTex?: THREE.WebGLCubeRenderTarget;
  /** LOD terrain, drawn instead of the sphere up close (render/Terrain.ts). */
  terrain?: TerrainView;
  dist: number; // m from the ship
  pxR: number; // apparent radius in pixels
}

/** Cloud deck height, in the air's scale heights (~9 km on an Earth). */
export const CLOUD_H = 1.3;

/**
 * Scattering coefficients at the ground (1/m, per colour) for the sky shader: Earth-like and ocean
 * worlds scatter like air (Rayleigh, ∝ λ⁻⁴: blue sky, red sunsets); the rest in their palette's sky
 * colour (dust, haze), thicker the denser the air.
 */
export function airBeta(b: World) {
  const a = atmoOf(b);
  if (!a) return new THREE.Vector3();
  const k = Math.min(a.rho0 / 1.2, 50); // (a 60 kg/m³ Venus-like air would be solid white otherwise)
  if (b.type === WT.EarthLike || b.type === WT.Ocean) return new THREE.Vector3(5.8e-6, 13.5e-6, 33.1e-6).multiplyScalar(k);
  const c = b.pal.atmo!.c;
  const m = Math.max(c.r, c.g, c.b, 1e-3);
  return new THREE.Vector3(c.r / m, c.g / m, c.b / m).multiplyScalar(1.5e-5 * Math.sqrt(k));
}

const MAXDOTS = 256;
/** Apparent radius (px) above which a world with relief is drawn as LOD terrain instead of a sphere. */
export const TERRAIN_PX = 200;
/** …and only within this many radii of its centre (without the periscope it turns on at ~7). */
export const TERRAIN_NEAR = 10;
/** Face size of the baked Milky Way cube map (6 × 1024² × 4 bytes ≈ 25 MB of GPU memory). */
const SKY_CUBE_SIZE = 1024;
/** ms a new periscope sky patch takes to fade in over the last one (also the least time between bakes). */
const CROSSFADE = 150;
/** Periscope sky patch resolution relative to the drawing buffer (it's re-baked every frame while zooming). */
const PATCH_SCALE = 0.5;
/** Most pixels the 3D view renders per frame (≈ 2980×1680); see setPixelRatio. */
const MAX_RENDER_PIXELS = 5e6;
/** Vertices in the orbit preview ring (spaced densely near the ship; see updateRing). */
export const RING_N = 720;
export const RING_PLAN = new THREE.Color(1, 0.65, 0.23); // amber while planning
export const RING_AP = new THREE.Color(0.5, 0.86, 1); // cyan once the autopilot flies it
/** Colour of a distant station's beacon dot (and its overlay marker): mint, unlike any body. */
export const STATION_RGB = new THREE.Color(0.45, 1, 0.7);
export const DUST = 700,
  DUSTBOX = 3000;
/** Dust fades out between these speeds (m/s), see updateDust. The boost limit (15 km/s) keeps it all. */
export const DUST_FADE_FROM = 20e3,
  DUST_FADE_TO = 60e3;

/**
 * Draws the system around the ship with three.js. The camera sits at the origin and every body
 * is placed relative to the ship, so positions stay precise at astronomical distances. The sky
 * (Milky Way and stars) is a separate scene drawn first with its own camera.
 */
export class SceneRenderer implements GameRenderer {
  readonly kind = 'webgl' as const;
  readonly gl: THREE.WebGLRenderer;
  readonly views = new Map<Body, BodyView>();
  /** Station views; a sky station has only its mesh (no interior, entry corridor or approach lights). */
  readonly stationViews = new Map<Station, { mesh: THREE.Group; uni: Uniforms; inner?: THREE.Mesh; innerUni?: Uniforms; corridor?: THREE.Mesh; corridorUni?: Uniforms; lights?: THREE.Points; lightsUni?: Uniforms; dist: number; pxR: number }>();
  /** Headlights, shared by every station material: the ship's nose (world axes) and on/off. */
  /** Exposure, shared by every physically lit material (render/exposure.ts): uExp, uSkyExp for the Milky Way and uStarExp for stars (see STAR_EXP_P). */
  private readonly expUni = { uExp: { value: 1 }, uSkyExp: { value: SKY_K }, uStarExp: { value: 1 } };
  /** Station lights in scene units (render/exposure.ts). */
  private readonly headUni = {
    uHeadDir: { value: new THREE.Vector3(0, 0, -1) }, uHeadOn: { value: 1 },
    uHeadK: { value: HEAD_K }, uFloodK: { value: FLOOD_K }, uHeadKi: { value: HEAD_K / INT_K },
    uIntK: { value: INT_K }, uWinK: { value: WINDOW_K }, uSkyK: { value: SKY_K },
    ...this.expUni,
  };
  /** HDR frame, metering and tone mapping (render/hdr.ts), and the eye's adaptation. */
  private readonly hdr: HdrTarget;
  private readonly exposure: AutoExposure;
  /** Station hull (slot cut in the front) and interior, shared by every station (render/stationMesh.ts). */
  private readonly stationHull = hullGeometry();
  private readonly stationInside = interiorGeometry();
  /** A sky station's deck, tower, keel and fans, shared by every one (render/skyMesh.ts). */
  private readonly skyStationGeo = skyStationGeometry();
  private readonly scene = new THREE.Scene();
  private readonly skyScene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 1e21);
  private readonly skyCam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
  /** Current render pixel ratio; point sprite sizes scale with it (shared uniform for their shaders). */
  private PR = 1;
  private readonly uPR = { value: 1 };
  private readonly geoHi = new THREE.SphereGeometry(1, 320, 160);
  private readonly geoMid = new THREE.SphereGeometry(1, 96, 48);
  private readonly geoLo = new THREE.SphereGeometry(1, 32, 16);
  private readonly plane = new THREE.PlaneGeometry(2, 2);
  private readonly box = new THREE.BoxGeometry(1, 1, 1);
  /** Fine-octave noise for the planet shaders (see lib/noise3d.ts). */
  private readonly noise3d = createNoiseTexture();
  private sysStars: THREE.Points | null = null;
  private skyCube!: THREE.WebGLCubeRenderTarget;
  /**
   * Periscope sky patch: the procedural sky re-baked for just the zoomed view, with detail scaled
   * to the magnification (see updateSkyPatch). Null until the periscope first zooms in.
   */
  private patch: { rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]; cur: number; cam: THREE.PerspectiveCamera; scene: THREE.Scene; mat: THREE.ShaderMaterial; q: THREE.Quaternion; zoom: number; bakedAt: number } | null = null;
  private skyUni!: {
    uSky: { value: THREE.Texture };
    uPatch: { value: THREE.Texture | null };
    uPatchPrev: { value: THREE.Texture | null };
    uPatchVP: { value: THREE.Matrix4 };
    uPatchPrevVP: { value: THREE.Matrix4 };
    uPatchOn: { value: number };
    uMix: { value: number };
    uSkyExp: { value: number };
  };
  private skyGeo!: THREE.SphereGeometry;
  /** Other ships (render/Traffic.ts). */
  private readonly trafficView = new TrafficView();
  /** The mining laser's beam and plume (render/Laser.ts). */
  private readonly laserView = new LaserView();
  /** A ring's rocks up close (render/RingField.ts). */
  private readonly ringField: RingField;
  private readonly hyper = new HyperspaceView(() => this.pointsMaterial(), this.expUni.uStarExp);
  /** Orbit preview (L): the planned or autopilot orbit as a ring, depth-tested so the planet hides its far side. */
  private readonly ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_N * 3), 3)),
    new THREE.LineBasicMaterial({ color: RING_PLAN.clone(), transparent: true, opacity: 0.8, depthWrite: false }),
  );
  private readonly dotGeo = new THREE.BufferGeometry();
  private readonly dustGeo = new THREE.BufferGeometry();
  private readonly dust: THREE.Points;
  private readonly dustSeed: [number, number, number][] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
  private readonly m4 = new THREE.Matrix4();

  bodyView(b: Body) {
    return this.views.get(b);
  }
  stationView(st: Station) {
    return this.stationViews.get(st);
  }

  constructor(readonly canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true }); // MSAA happens in the HDR target
    this.gl.autoClear = false;
    this.setPixelRatio(innerWidth, innerHeight);
    this.hdr = new HdrTarget(this.gl);
    this.exposure = new AutoExposure(this.gl);
    this.buildSky();

    // distant bodies drawn as dots of reflected starlight
    this.dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXDOTS * 3), 3));
    this.dotGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAXDOTS * 3), 3));
    this.dotGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAXDOTS), 1));
    const dots = new THREE.Points(this.dotGeo, new THREE.ShaderMaterial({ vertexShader: POINT_VS, fragmentShader: POINT_FS, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    dots.frustumCulled = false;
    this.scene.add(dots);
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.scene.add(this.ring);
    this.scene.add(this.trafficView.group);
    this.scene.add(this.laserView.group);
    this.ringField = new RingField(this.expUni.uExp, this.noise3d, this.headUni);
    this.scene.add(this.ringField.group);

    // dust around the ship, so you can feel your speed in normal space
    const g = mulberry32(99);
    for (let i = 0; i < DUST; i++) this.dustSeed.push([g() * DUSTBOX, g() * DUSTBOX, g() * DUSTBOX]);
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));
    this.dustGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(DUST * 3), 3));
    this.dustGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(DUST), 1));
    this.dust = new THREE.Points(this.dustGeo, dots.material);
    this.dust.frustumCulled = false;
    this.scene.add(this.dust);
  }

  /**
   * Render at up to 1.5× the CSS resolution, but never more than MAX_RENDER_PIXELS in total: a
   * 4K screen otherwise renders 8+ megapixels a frame for little visible gain (the HUD and
   * overlay stay sharp either way; they're drawn separately).
   */
  private setPixelRatio(W: number, H: number) {
    const pr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(MAX_RENDER_PIXELS / Math.max(1, W * H)));
    this.gl.setPixelRatio(pr);
    this.PR = this.uPR.value = pr;
    (this.dustGeo.attributes.aSize?.array as Float32Array | undefined)?.fill(2.2 * pr);
    if (this.dustGeo.attributes.aSize) this.dustGeo.attributes.aSize.needsUpdate = true;
  }

  resize(W: number, H: number) {
    this.setPixelRatio(W, H);
    this.gl.setSize(W, H, false);
    this.camera.aspect = this.skyCam.aspect = W / H;
    this.camera.updateProjectionMatrix();
    this.skyCam.updateProjectionMatrix();
    this.hdr.resize();
  }

  private pointsMaterial() {
    return new THREE.ShaderMaterial({ vertexShader: SKYPT_VS, fragmentShader: SKYPT_FS, uniforms: { uPR: this.uPR, uStarExp: this.expUni.uStarExp }, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  }

  /**
   * The Milky Way band: unresolved light from distant stars. Every individual star in the sky is a
   * real system you can fly to (see buildSysStars), so there are no decorative points.
   */
  private buildSky() {
    // The Milky Way depends only on view direction, so render its (expensive, noise-heavy) shader
    // once into a cube map and just sample that every frame. Evaluating it per pixel per frame
    // cost ~22 ms at 3840×2160; the bake takes a few ms at startup.
    const geo = new THREE.SphereGeometry(100, 64, 32);
    const bakeScene = new THREE.Scene();
    const bakeMat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_BAKE_FS, uniforms: { uPxPerRad: { value: SKY_CUBE_SIZE / (Math.PI / 2) } }, side: THREE.BackSide, depthWrite: false });
    bakeScene.add(new THREE.Mesh(geo, bakeMat));
    this.skyCube = new THREE.WebGLCubeRenderTarget(SKY_CUBE_SIZE, { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    new THREE.CubeCamera(1, 1000, this.skyCube).update(this.gl, bakeScene);
    bakeMat.dispose();
    this.skyGeo = geo;
    this.skyUni = {
      uSky: { value: this.skyCube.texture },
      uPatch: { value: null },
      uPatchPrev: { value: null },
      uPatchVP: { value: new THREE.Matrix4() },
      uPatchPrevVP: { value: new THREE.Matrix4() },
      uPatchOn: { value: 0 },
      uMix: { value: 1 },
      uSkyExp: this.expUni.uSkyExp,
    };
    const sky = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_CUBE_FS, uniforms: this.skyUni, side: THREE.BackSide, depthWrite: false }));
    this.skyScene.add(sky);
  }

  /**
   * Through the periscope the 1024² cube map is far too coarse (at 100× a cube texel spans ~7 screen
   * pixels), so the procedural sky is re-baked for just the view: a patch 30% wider than the screen
   * at half its resolution, with finer glow and dust in the band and the nebulae (no new stars). It's
   * re-baked every frame while the zoom moves (so detail grows smoothly), then only when the view
   * turns by more than a tenth of the field, so a steady view costs nothing extra.
   */
  private updateSkyPatch(g: Game) {
    const z = g.zoom.cur;
    const u = this.skyUni;
    // baked from 2×, blended in over 2–4× so its extra detail never pops in
    if (z < 2) {
      u.uPatchOn.value = 0;
      if (this.patch) this.patch.zoom = 0; // start fresh next time
      return;
    }
    const size = this.gl.getDrawingBufferSize(new THREE.Vector2());
    const w = Math.max(64, Math.round(size.x * PATCH_SCALE)),
      h = Math.max(64, Math.round(size.y * PATCH_SCALE));
    let p = this.patch;
    if (!p) {
      const mat = new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_BAKE_FS, uniforms: { uPxPerRad: { value: 1 } }, side: THREE.BackSide, depthWrite: false });
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(this.skyGeo, mat));
      const mk = () => new THREE.WebGLRenderTarget(w, h, { generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
      p = this.patch = { rts: [mk(), mk()], cur: 0, cam: new THREE.PerspectiveCamera(), scene, mat, q: new THREE.Quaternion(), zoom: 0, bakedAt: 0 };
    }
    if (p.rts[0].width !== w || p.rts[0].height !== h) {
      for (const rt of p.rts) rt.setSize(w, h);
      p.zoom = 0;
    }
    const now = performance.now();
    const fovRad = (g.fov * Math.PI) / 180;
    const first = !p.zoom;
    // While the zoom is moving, re-bake every frame: each layer's detail strength is set at bake
    // time, so baking in steps made detail pop in at each step. Once it settles, re-bake only when
    // the view turns by a tenth of the field (at most once per CROSSFADE, fading from the last patch).
    const moving = Math.abs(z / (g.zoom.on ? g.zoom.mag : 1) - 1) > 0.002;
    const stale = first || moving || z !== p.zoom || p.q.angleTo(g.ship.q) > fovRad * 0.1;
    if (stale && (first || moving || now - p.bakedAt > CROSSFADE)) {
      const cam = p.cam;
      // zooming out, the view is about to widen: bake a wider margin so the edges stay covered
      cam.fov = g.fov * (z < p.zoom ? 2 : 1.3);
      cam.aspect = w / h;
      cam.near = 0.1;
      cam.far = 1000;
      cam.quaternion.copy(g.ship.q);
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      p.mat.uniforms.uPxPerRad.value = h / 2 / Math.tan(((cam.fov / 2) * Math.PI) / 180);
      const next = 1 - p.cur;
      const prevRT = this.gl.getRenderTarget();
      this.gl.setRenderTarget(p.rts[next]);
      this.gl.clear();
      this.gl.render(p.scene, cam);
      this.gl.setRenderTarget(prevRT);
      // the old patch becomes the one we fade from
      u.uPatchPrev.value = first ? p.rts[next].texture : p.rts[p.cur].texture;
      u.uPatchPrevVP.value.copy(first ? new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse) : u.uPatchVP.value);
      u.uPatchVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      u.uPatch.value = p.rts[next].texture;
      p.cur = next;
      p.q.copy(g.ship.q);
      p.zoom = z;
      p.bakedAt = moving ? now - CROSSFADE : now; // per-frame bakes don't crossfade
    }
    u.uMix.value = Math.min(1, (now - p.bakedAt) / CROSSFADE);
    u.uPatchOn.value = THREE.MathUtils.smoothstep(z, 2, 4);
  }

  /** Every other system within SKY_RADIUS as a sky point, brightness and size by flux from here. */
  private buildSysStars(cur: StarSystem, systems: StarSystem[]) {
    if (this.sysStars) {
      this.skyScene.remove(this.sysStars);
      this.sysStars.geometry.dispose();
      (this.sysStars.material as THREE.Material).dispose();
    }
    const others = systems.filter((s) => s.id !== cur.id);
    const N = others.length,
      pos = new Float32Array(N * 3),
      col = new Float32Array(N * 3),
      size = new Float32Array(N);
    others.forEach((s, i) => {
      const d = s.pos.clone().sub(cur.pos);
      const { size: sz, k } = skyLook(s.star.L, d.length());
      d.normalize().multiplyScalar(80);
      pos.set([d.x, d.y, d.z], i * 3);
      const c = skyColor(s.star.color, k);
      col.set([c.r, c.g, c.b], i * 3);
      size[i] = sz;
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
    for (const st of cur.stations) this.stationViews.set(st, this.attachStation(st, cur.star));
    this.buildSysStars(cur.sys, systems);
  }

  private isShared(geo: THREE.BufferGeometry) {
    return geo === this.geoHi || geo === this.geoMid || geo === this.geoLo || geo === this.plane || geo === this.box;
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
      v.cloudTex?.dispose();
    }
    this.views.clear();
    for (const v of this.stationViews.values()) {
      this.scene.remove(v.mesh);
      v.mesh.traverse((o) => {
        if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose(); // geometry is shared
      });
    }
    this.stationViews.clear();
  }

  /** Is the station in sunlight (not in its world's shadow)? */
  private readonly litA = new THREE.Vector3();
  private readonly litB = new THREE.Vector3();
  private stationLit(st: Station, starPos: THREE.Vector3) {
    const toStar = this.litA.subVectors(starPos, st.pos).normalize();
    const w = this.litB.subVectors(st.parent.pos, st.pos);
    const t = w.dot(toStar);
    return !(t > 0 && w.lengthSq() - t * t < st.parent.radius * st.parent.radius);
  }

  private attachStation(st: Station, star: Star) {
    if (st.sky) return this.attachSkyStation(st, star);
    const p = st.parent.pal;
    const uni: Uniforms = {
      uLight: { value: new THREE.Vector3() }, uStarColor: { value: star.color.clone().lerp(new THREE.Color(1, 1, 1), 0.5) }, uLit: { value: 1 },
      uPlanetDir: { value: new THREE.Vector3() }, uPlanetColor: { value: p.a.clone().lerp(p.b, 0.5) }, uPlanetSize: { value: 1 }, uSeed: { value: st.seed },
      uTime: { value: 0 }, ...this.headUni,
    };
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.stationHull, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: STATION_FS, uniforms: uni, side: THREE.DoubleSide })));
    const innerUni: Uniforms = { uPad: { value: new THREE.Vector3() }, uPadOn: { value: 0 }, uTime: { value: 0 }, uSeed: { value: st.seed }, ...this.headUni };
    const inner = new THREE.Mesh(this.stationInside, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: STATION_INTERIOR_FS, uniforms: innerUni, side: THREE.DoubleSide }));
    group.add(inner);
    // the entry corridor (5 km out along the spin axis): its walls glow while you have a pad here,
    // and its approach lights are always on
    const len = CORRIDOR_M / st.size;
    const corridorUni: Uniforms = { uTime: { value: 0 }, uLen: { value: len }, uGrow: { value: CORRIDOR_GROW } };
    const corridor = new THREE.Mesh(
      corridorGeometry(len),
      new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: CORRIDOR_FS, uniforms: corridorUni, side: THREE.DoubleSide, transparent: true, depthWrite: false,
        // colour adds; alpha multiplies the meter weight underneath (render/hdr.ts)
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor }),
    );
    corridor.visible = false;
    group.add(corridor);
    const lightsUni: Uniforms = { uTime: { value: 0 }, uPxPerRad: { value: 1000 }, uSize: { value: st.size }, uBusy: { value: 0 }, uDir: { value: 1 } };
    const lights = new THREE.Points(
      corridorLights(len),
      new THREE.ShaderMaterial({ vertexShader: CORRIDOR_LIGHT_VS, fragmentShader: CORRIDOR_LIGHT_FS, uniforms: lightsUni, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor }),
    );
    lights.frustumCulled = false;
    group.add(lights);
    group.scale.setScalar(st.size);
    this.scene.add(group);
    return { mesh: group, uni, inner, innerUni, corridor, corridorUni, lights, lightsUni, dist: Infinity, pxR: 0 };
  }

  /** Far off, a station is a mint beacon dot: add it to the dots (at index nd) if it's small enough. */
  private stationDot(v: { pxR: number }, rel: THREE.Vector3, dPos: Float32Array, dCol: Float32Array, dSize: Float32Array, nd: number, hidden: boolean) {
    // (not through the world it's behind: the HUD's crossed square marks it instead)
    if (v.pxR >= 2.5 || nd >= MAXDOTS || hidden) return false;
    const a = v.pxR < 1.2 ? 1 : (2.5 - v.pxR) / 1.3;
    dPos.set([rel.x, rel.y, rel.z], nd * 3);
    dCol.set([STATION_RGB.r * a, STATION_RGB.g * a, STATION_RGB.b * a], nd * 3);
    dSize[nd] = 3.2 * this.PR;
    return true;
  }

  /** A sky station: its mesh, lit and hazed through its world's air (shares the world's air uniforms). */
  private attachSkyStation(st: Station, star: Star) {
    const wu = this.views.get(st.parent)!.uni!;
    const uni: Uniforms = {
      uLight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uSeed: { value: st.seed }, uTime: { value: 0 },
      uPadPos: { value: Array.from({ length: SKY_PAD_COUNT }, (_, i) => { const p = skyPadLocal(i).pos; return new THREE.Vector2(p.x, p.y); }) },
      uPadR: { value: PAD_R }, uPad: { value: -1 },
      uAtC: wu.uAtC, uAtR: wu.uAtR, uAtH: wu.uAtH, uAtTop: wu.uAtTop, uAtBeta: wu.uAtBeta, uAtSunI: wu.uAtSunI, uAtOn: wu.uAtOn,
      ...this.headUni,
    };
    void star;
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.skyStationGeo, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: SKY_STATION_FS, uniforms: uni, side: THREE.DoubleSide })));
    group.scale.setScalar(st.size);
    this.scene.add(group);
    return { mesh: group, uni, dist: Infinity, pxR: 0 };
  }

  /**
   * Bake a world's cloud pattern (clouds.glsl cloudRaw, 7 octaves) into a 1024² cube map in its own
   * frame: the cloud layer and the cloud shadows read it instead of evaluating the noise per pixel.
   */
  private bakeClouds(b: World) {
    const rt = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const mat = new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: CLOUD_BAKE_FS, side: THREE.BackSide, depthWrite: false, uniforms: { uSeed: { value: b.seed }, uType: { value: b.type }, uNoise3D: { value: this.noise3d } } });
    const scene = new THREE.Scene();
    const sphere = new THREE.Mesh(this.geoMid, mat);
    sphere.scale.setScalar(100);
    scene.add(sphere);
    new THREE.CubeCamera(1, 1000, rt).update(this.gl, scene);
    mat.dispose();
    return rt;
  }

  private attachStar(b: Star): BodyView {
    const group = new THREE.Group();
    this.scene.add(group);
    const mesh = new THREE.Mesh(this.geoMid, new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: STAR_FS, uniforms: { uColor: { value: b.color }, uTime: { value: 0 }, uSeed: { value: b.seed } } }));
    mesh.scale.setScalar(b.radius);
    group.add(mesh);
    const glow = new THREE.Mesh(
      this.plane,
      new THREE.ShaderMaterial({ vertexShader: GLOW_VS, fragmentShader: GLOW_FS, uniforms: { uColor: { value: b.color.clone().lerp(new THREE.Color(1, 1, 1), 0.2) }, uI: { value: 1 } }, transparent: true, depthWrite: false,
        // colour adds; alpha (0) masks it out of the exposure meter (render/hdr.ts)
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor }),
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
    const air = atmoOf(b);
    // weather: Earth-like and ocean worlds get a cloud layer
    const clouded = !!air && (b.type === WT.EarthLike || b.type === WT.Ocean);
    const uni: Uniforms = {
      uType: { value: b.type }, uOct: { value: 5 },
      uA: { value: b.pal.a }, uB: { value: b.pal.b }, uC: { value: b.pal.c }, uD: { value: b.pal.d },
      uAtmo: { value: atmo ? atmo.c : new THREE.Color(0, 0, 0) }, uAtmoK: { value: atmo ? atmo.k * 0.6 : 0 },
      uSea: { value: b.pal.sea }, uSeed: { value: b.seed }, uTime: { value: 0 }, uLight: { value: light }, uNoise3D: { value: this.noise3d },
      uExp: this.expUni.uExp,
      // terrain height (sim/terrain.ts): per-octave offsets and relief amplitude
      uTOff: { value: terrainOffsets(b.seed) }, uTerrA: { value: reliefAmp(b) }, uCamAlt: { value: 1e9 },
      uRadius: { value: b.radius }, uCraters: { value: hasCraters(b) ? 1 : 0 },
      // the air (sim/atmosphere.ts; shaders/atmo.glsl), shared by the ground, the sky and the clouds
      uAtC: { value: new THREE.Vector3() }, uAtR: { value: b.radius }, uAtH: { value: air?.H ?? 1 }, uAtTop: { value: b.radius + (air?.top ?? 0) },
      uAtBeta: { value: airBeta(b) }, uAtSunI: { value: 45 }, uAtOn: { value: air ? 1 : 0 },
      uLightL: { value: new THREE.Vector3(0, 1, 0) }, uCloudH: { value: clouded ? air!.H * CLOUD_H : 0 },
      uToLocal: { value: new THREE.Matrix3() }, uCloudTex: { value: null },
      // populated worlds light up at night (shaders/cityLights.glsl)
      uCity: { value: populated(b) ? 1 : 0 }, uCityK: { value: CITY_K },
    };
    const mesh = new THREE.Mesh(this.geoMid, new THREE.ShaderMaterial({ vertexShader: PLANET_VS, fragmentShader: PLANET_FS, uniforms: uni }));
    mesh.scale.setScalar(b.radius);
    mesh.rotation.y = b.rot;
    tilt.add(mesh);
    const view: BodyView = { group, mesh, uni, light, dist: Infinity, pxR: 0 };
    if (reliefAmp(b) > 0) {
      view.terrain = new TerrainView(b, uni);
      tilt.add(view.terrain.root);
    }
    if (air) {
      // the sky: a shell at the top of the air (shaders/atmosphere.frag.glsl); it adds the scattered
      // light and dims what's behind it (blending: src + dst × alpha)
      view.atmo = new THREE.Mesh(
        this.geoHi,
        new THREE.ShaderMaterial({
          vertexShader: BODY_VS, fragmentShader: ATMO_FS, side: THREE.BackSide, transparent: true, depthWrite: false, uniforms: uni,
          blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        }),
      );
      view.atmo.scale.setScalar((b.radius + air.top) * 1.001); // the facets must cover the exact sphere
      view.atmo.renderOrder = 1;
      group.add(view.atmo);
    }
    if (clouded) {
      view.cloudTex = this.bakeClouds(b);
      uni.uCloudTex.value = view.cloudTex.texture;
      // the cloud layer at the deck's height (shaders/cloudLayer.frag.glsl), seen from above or below
      view.clouds = new THREE.Mesh(
        this.geoHi,
        new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: CLOUD_FS, side: THREE.DoubleSide, transparent: true, depthWrite: false, uniforms: { ...uni, uCloudR: { value: b.radius + air!.H * CLOUD_H } } }),
      );
      view.clouds.scale.setScalar((b.radius + air!.H * CLOUD_H) * 1.001);
      view.clouds.renderOrder = 2;
      group.add(view.clouds);
    }
    if (b.ring) {
      view.ringUni = { uColor: { value: b.ring.color }, uLight: { value: light }, uPC: { value: new THREE.Vector3() }, uPR: { value: b.radius }, uIn: { value: b.ring.inner }, uOut: { value: b.ring.outer }, uSeed: { value: b.ring.seed }, uExp: this.expUni.uExp, uNearFade: { value: 0 } };
      const rm = new THREE.Mesh(new THREE.RingGeometry(b.ring.inner, b.ring.outer, 256, 1), new THREE.ShaderMaterial({ vertexShader: BODY_VS, fragmentShader: RING_FS, uniforms: view.ringUni, side: THREE.DoubleSide, transparent: true, depthWrite: false }));
      rm.rotation.x = -Math.PI / 2;
      rm.scale.setScalar(b.radius);
      tilt.add(rm);
    }
    view.dotColor = b.pal.a.clone().lerp(b.pal.b, 0.5).lerp(new THREE.Color(1, 1, 1), 0.4);
    return view;
  }

  /**
   * Draw the frame into the HDR target at the current exposure, then meter it, adapt and tone-map
   * it to the screen (render/exposure.ts).
   */
  render(g: Game) {
    this.perf = g.perf.splitting ? g.perf : null;
    const e = this.exposure.value;
    this.expUni.uExp.value = e;
    this.expUni.uSkyExp.value = AUTO_EXPOSURE ? (e / MAX_EXP) ** SKY_EXP_P : 1;
    this.expUni.uStarExp.value = AUTO_EXPOSURE ? (e / MAX_EXP) ** STAR_EXP_P : 1;
    this.gl.setRenderTarget(this.hdr.target);
    this.renderScene(g);
    this.perf?.gpuSegment('post');
    this.hdr.finish(this.exposure);
  }

  private renderScene(g: Game) {
    const { ship, cur, simTime } = g;
    // in hyperspace: only the Milky Way and the real stars streaming past, no system scene
    const inTunnel = !!g.jump && g.jump.phase === 'tunnel';
    // periscope: narrow the field of view (sim/periscope.ts)
    if (this.camera.fov !== g.fov) {
      this.camera.fov = this.skyCam.fov = g.fov;
      this.camera.updateProjectionMatrix();
      this.skyCam.updateProjectionMatrix();
    }
    if (this.sysStars) this.sysStars.visible = !inTunnel;
    if (inTunnel) {
      this.skyCam.quaternion.copy(ship.q);
      this.skyCam.updateMatrixWorld();
      this.gl.clear();
      this.gl.render(this.skyScene, this.skyCam);
      this.hyper.render(this.gl, g.jump!, ship.q, this.camera.aspect, g.fov);
      return;
    }
    this.hyper.dispose();
    const { pxPerRad } = g.view;
    const { camera, skyCam, dotGeo, PR, tmp, tmp2 } = this;
    this.headUni.uHeadDir.value.set(0, 0, -1).applyQuaternion(ship.q);
    this.headUni.uHeadOn.value = g.lights ? 1 : 0;
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(ship.q);
    camera.updateMatrixWorld();
    skyCam.quaternion.copy(ship.q);
    skyCam.updateMatrixWorld();
    this.perf?.gpuSegment('sky bake'); // the periscope's sky patch, when it re-bakes
    this.updateSkyPatch(g);

    const dPos = dotGeo.attributes.position.array as Float32Array,
      dCol = dotGeo.attributes.aColor.array as Float32Array,
      dSize = dotGeo.attributes.aSize.array as Float32Array;
    let nd = 0;
    const starPos = cur.star.pos;
    let ringDone = false;
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
      if (v.atmo) v.atmo.visible = pxR > 2;
      if (v.clouds) v.clouds.visible = pxR > 2;
      if (b.kind === 'star') {
        (v.mesh.material as THREE.ShaderMaterial).uniforms.uTime.value = simTime;
        const flux = b.L * (AU / d) * (AU / d);
        const I = Math.min(1.5, Math.max(0.35, 0.95 + 0.2 * Math.log10(flux)));
        const minPx = (16 + 22 * I) * 1.6; // the system's star: a big, bright mark
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
      uni.uCamAlt.value = d - b.radius;
      v.light!.subVectors(starPos, b.pos).normalize(); // worlds orbit, so the lit side turns
      uni.uOct.value = Math.max(4, Math.min(17, Math.round(4 + Math.log2(Math.max(pxR, 1) / 30))));
      // the air and clouds work in camera-relative world space and the world's own frame
      const qInvW = worldQuat(b as World).invert();
      (uni.uAtC.value as THREE.Vector3).copy(rel);
      (uni.uLightL.value as THREE.Vector3).copy(v.light!).applyQuaternion(qInvW);
      (uni.uToLocal.value as THREE.Matrix3).setFromMatrix4(this.m4.makeRotationFromQuaternion(qInvW));
      // up close, LOD terrain replaces the sphere (render/Terrain.ts), fed the camera in the world's frame
      const ter = v.terrain;
      if (ter) {
        // big on screen and actually close: through the periscope a world across the system can be
        // hundreds of px, but chunks positioned from ~10¹¹ m away lose their precision and flashed
        const on = pxR > TERRAIN_PX && d < b.radius * TERRAIN_NEAR;
        ter.root.visible = on;
        if (on) {
          v.mesh.visible = false;
          ter.root.rotation.y = b.rot;
          this.perf?.gpuSegment('terrain bake'); // new chunks and sun re-bakes
          ter.update(tmp2.subVectors(ship.pos, b.pos).applyQuaternion(qInvW), this.tmp3.copy(v.light!).applyQuaternion(qInvW), this.gl);
        }
      }
      if (v.ringUni) {
        (v.ringUni.uPC.value as THREE.Vector3).copy(rel);
        // up close, the ring's rocks (render/RingField.ts); the nearest ringed world has them
        v.ringUni.uNearFade.value = 0;
        if (!ringDone && this.ringField.update(b as World, rel, b.axis, v.light!, simTime, pxPerRad * this.PR)) {
          ringDone = true;
          v.ringUni.uNearFade.value = this.ringField.nearFade;
        }
      }
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
          const k = a * this.expUni.uStarExp.value; // like the stars
          dCol[nd * 3] = c.r * k;
          dCol[nd * 3 + 1] = c.g * k;
          dCol[nd * 3 + 2] = c.b * k;
          dSize[nd] = (2.2 + 2.5 * a) * PR;
          nd++;
        }
      }
    }
    // stations: tumbling cubes up close, mint beacon dots far away
    for (const [st, v] of this.stationViews) {
      const rel = tmp.subVectors(st.pos, ship.pos);
      const d = rel.length();
      v.dist = d;
      v.pxR = (st.radius / d) * pxPerRad;
      v.mesh.position.copy(rel);
      stationQuat(st, simTime, v.mesh.quaternion);
      v.mesh.visible = v.pxR > 0.5;
      const now = performance.now() / 1000;
      v.uni.uTime.value = now;
      const dk = g.dock;
      if (st.sky) {
        // a sky station: its up, the sun, and your pad lit up while it's granted
        (v.uni.uUp.value as THREE.Vector3).subVectors(st.pos, st.parent.pos).normalize();
        (v.uni.uLight.value as THREE.Vector3).subVectors(starPos, st.pos).normalize();
        v.uni.uPad.value = dk && dk.station === st && !dk.docked ? dk.pad : -1;
        if (this.stationDot(v, rel, dPos, dCol, dSize, nd, !!occluder(g.cur.bodies, ship.pos, st.pos))) nd++;
        continue;
      }
      if (!v.inner || !v.innerUni || !v.corridor || !v.corridorUni || !v.lights || !v.lightsUni) continue;
      // the interior only matters up close (it's seen through the slot, or from inside)
      v.inner.visible = d < st.size * 8;
      // traffic control (sim/control.ts): another ship using the slot, and which way it's going
      const other = d < 60e3 ? slotUser(g, st) : null;
      const outbound = !!other && (other.autodock?.phase === 'exit' || other.autodock?.phase === 'rise');
      // the corridor's walls glow while you have a pad here, or while another ship is in it
      v.corridor.visible = ((!!dk && dk.station === st && !dk.docked) || !!other) && !g.inStation;
      if (v.corridor.visible) v.corridorUni.uTime.value = now;
      // approach lights: on within 60 km, from outside the station; amber while another ship has
      // the slot, their pulses running the way it's going (in, or out)
      v.lights.visible = d < 60e3 && !g.inStation;
      if (v.lights.visible) {
        v.lightsUni.uTime.value = now;
        v.lightsUni.uPxPerRad.value = pxPerRad;
        v.lightsUni.uBusy.value = other ? 1 : 0;
        v.lightsUni.uDir.value = outbound ? -1 : 1;
      }
      if (v.inner.visible) {
        v.innerUni.uPadOn.value = dk && dk.station === st && !dk.docked ? 1 : 0;
        if (dk && dk.station === st) (v.innerUni.uPad.value as THREE.Vector3).copy(padLocal(dk.pad).pos);
        v.innerUni.uTime.value = performance.now() / 1000;
      }
      const toStar = tmp2.subVectors(starPos, st.pos).normalize();
      (v.uni.uLight.value as THREE.Vector3).copy(toStar);
      // in the parent's shadow if the line to the star passes through it
      const par = st.parent;
      const w = this.tmp3.subVectors(par.pos, st.pos);
      v.uni.uLit.value = this.stationLit(st, starPos) ? 1 : 0;
      const pd = w.length();
      (v.uni.uPlanetDir.value as THREE.Vector3).copy(w).divideScalar(pd);
      v.uni.uPlanetSize.value = Math.cos(Math.asin(Math.min(1, par.radius / pd)));
      if (this.stationDot(v, rel, dPos, dCol, dSize, nd, !!occluder(g.cur.bodies, ship.pos, st.pos))) nd++;
    }
    dotGeo.setDrawRange(0, nd);
    dotGeo.attributes.position.needsUpdate = dotGeo.attributes.aColor.needsUpdate = dotGeo.attributes.aSize.needsUpdate = true;

    this.updateDust(g);
    this.trafficView.update(g, this.PR);
    this.laserView.update(g, this.PR);
    this.ringField.group.visible = ringDone;
    this.updateRing(g);

    const gl = this.gl;
    if (this.perf) for (const s of [this.skyScene, this.scene]) s.traverse((o) => this.perfTag(o));
    gl.clear();
    gl.render(this.skyScene, skyCam);
    gl.clearDepth();
    gl.render(this.scene, camera);
  }

  /** The perf monitor while it splits GPU time by category (debug/Perf.ts), else null. */
  private perf: Game['perf'] | null = null;

  /**
   * Split GPU timing: give a drawable a hook that tells the perf monitor what kind of thing it is
   * just before it's drawn (by its shader), so each category's draws are timed together.
   */
  private perfTag(o: THREE.Object3D) {
    if (o.userData.perfTag || !(o as THREE.Mesh).material) return;
    const m = (o as THREE.Mesh).material as THREE.ShaderMaterial;
    const fs = m.fragmentShader;
    const cat =
      fs === PLANET_FS ? (m.defines?.TERRAIN !== undefined ? 'terrain' : 'planet')
        : fs === CLOUD_FS ? 'clouds'
          : fs === ATMO_FS ? 'air'
            : fs === SKY_FS || fs === SKY_CUBE_FS || fs === SKYPT_FS ? 'sky'
              : fs === RING_FS ? 'rings'
                : fs === STAR_FS || fs === GLOW_FS ? 'star'
                  : fs === STATION_FS || fs === SKY_STATION_FS || fs === STATION_INTERIOR_FS || fs === CORRIDOR_FS || fs === CORRIDOR_LIGHT_FS ? 'stations'
                    : (o as THREE.Points).isPoints ? 'points'
                      : 'other';
    o.userData.perfTag = cat;
    const prev = o.onBeforeRender;
    o.onBeforeRender = (...args) => {
      this.perf?.gpuSegment(cat);
      prev.apply(o, args);
    };
  }

  /**
   * Orbit preview ring, placed relative to the ship like everything else. An orbit is a full
   * circle in its plane; a hold point gets a small circle facing the body, sized to stay visible.
   */
  private updateRing(g: Game) {
    const pv = orbitPreview(g);
    this.ring.visible = !!pv;
    if (!pv) return;
    const { ship } = g;
    const pos = this.ring.geometry.attributes.position.array as Float32Array;
    const centre = this.tmp.copy(pv.point ?? pv.body.pos).sub(ship.pos);
    let n: THREE.Vector3, r: number;
    if (pv.n) {
      n = pv.n;
      r = pv.r;
    } else {
      n = this.tmp2.subVectors(pv.point!, pv.body.pos).normalize();
      r = Math.max(2e3, 0.012 * centre.length()); // ~0.7° across wherever you view it from
    }
    // two unit vectors spanning the plane, with `a` pointing at the ship's own angle on the orbit
    const a = new THREE.Vector3().subVectors(ship.pos, pv.point ?? pv.body.pos);
    a.addScaledVector(n, -a.dot(n));
    if (a.lengthSq() < 1e-6) a.set(1, 0, 0).cross(n);
    if (a.lengthSq() < 1e-6) a.set(0, 1, 0).cross(n);
    a.normalize();
    const b = new THREE.Vector3().crossVectors(n, a);
    for (let i = 0; i < RING_N; i++) {
      // A uniform polygon's chords sag ~300 m below a low orbit between vertices, so the line near
      // you wobbled in and out as you flew along it. Instead, start the ring at the ship and space
      // vertices cubically: centimetres apart beside you, ~2° apart on the far side (where a
      // kilometre of sag is invisible from 10,000+ km away).
      const u = (2 * i) / RING_N - 1; // −1…1, 0 = the ship
      const t = pv.n ? Math.PI * u * u * u : (i / RING_N) * Math.PI * 2,
        c = Math.cos(t) * r,
        s = Math.sin(t) * r;
      pos[i * 3] = centre.x + a.x * c + b.x * s;
      pos[i * 3 + 1] = centre.y + a.y * c + b.y * s;
      pos[i * 3 + 2] = centre.z + a.z * c + b.z * s;
    }
    this.ring.geometry.attributes.position.needsUpdate = true;
    (this.ring.material as THREE.LineBasicMaterial).color.copy(pv.engaged ? RING_AP : RING_PLAN).convertLinearToSRGB(); // display-referred: the HDR target isn't sRGB-encoded
  }

  /**
   * Dust particles wrap around the ship in a box, fading toward its edges. They fade out with speed
   * too: past a few km per frame the box is crossed several times a frame, so the grains would just
   * be re-scattered at random every frame and read as a field of extra faint stars (seen during a
   * hyperjump's departure, then "vanishing" when hyperspace began). Real grains that fast are
   * invisible anyway.
   */
  private updateDust(g: Game) {
    const { ship } = g;
    const dust = this.dust;
    const fade = 1 - THREE.MathUtils.smoothstep(g.curSpeed, DUST_FADE_FROM, DUST_FADE_TO);
    dust.visible = ship.mode === 'normal' && fade > 0;
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
      const f = Math.max(0, 1 - Math.sqrt(x * x + y * y + z * z) / h) * 0.55 * fade;
      c[i * 3] = f;
      c[i * 3 + 1] = f * 0.92;
      c[i * 3 + 2] = f * 0.85;
    }
    this.dustGeo.attributes.position.needsUpdate = this.dustGeo.attributes.aColor.needsUpdate = true;
  }

  dispose() {
    this.disposeSystem();
    this.ringField.dispose();
    this.hyper.dispose();
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    const dispose = (o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    };
    this.scene.traverse(dispose);
    this.skyScene.traverse(dispose);
    this.skyCube.dispose();
    if (this.patch) {
      for (const rt of this.patch.rts) rt.dispose();
      this.patch.mat.dispose();
      this.patch = null;
    }
    this.noise3d.dispose();
    this.trafficView.dispose();
    this.laserView.dispose();
    this.hdr.dispose();
    this.exposure.dispose();
    for (const geo of [this.geoHi, this.geoMid, this.geoLo, this.plane, this.box]) geo.dispose();
    this.gl.dispose();
  }
}
