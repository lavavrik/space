import { FOV, SKY_RADIUS } from '../constants';
import { THREE } from '../lib/three';
import { skyColor, skyLook, transitState, type TransitState } from '../sim/hyperspace';
import type { Jump, StarSystem } from '../types';
import { systemsNear } from '../universe/galaxy';

/** How long (s) a streak "exposes": its length is the distance travelled in this time. */
const STREAK_S = 0.22;

/**
 * The star field during a hyperspace transit, in light-years. Every real system within SKY_RADIUS
 * of the path is drawn at its true position relative to the moving ship, as a bright head plus a
 * streak trailing back along the direction of travel. Nearby stars sweep past with parallax and
 * smear far more than distant ones; streaks grow and shrink with the ship's speed.
 */
export class HyperspaceView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 1e-5, 2000);
  private jump: Jump | null = null;
  private stars: StarSystem[] = [];
  private heads: THREE.Points | null = null;
  private trails: THREE.LineSegments | null = null;
  private st: TransitState | undefined;
  private readonly rel = new THREE.Vector3();
  private readonly c = new THREE.Color();

  constructor(private readonly pointsMaterial: () => THREE.ShaderMaterial) {}

  /** Draw the transit for `j` from the ship's orientation `q`. Builds the star set on first use. */
  render(gl: THREE.WebGLRenderer, j: Jump, q: THREE.Quaternion, aspect: number, fov = FOV) {
    if (this.jump !== j) this.build(j);
    const st = (this.st = transitState(j, this.st));
    const hp = this.heads!.geometry.attributes.position.array as Float32Array,
      hc = this.heads!.geometry.attributes.aColor.array as Float32Array,
      hs = this.heads!.geometry.attributes.aSize.array as Float32Array,
      lp = this.trails!.geometry.attributes.position.array as Float32Array,
      lc = this.trails!.geometry.attributes.color.array as Float32Array;
    const tail = st.speed * STREAK_S;
    const blur = Math.min(1, st.speed / 2); // heads fade into their streaks at speed
    this.stars.forEach((s, i) => {
      const rel = this.rel.subVectors(s.pos, st.pos);
      const d = Math.max(rel.length(), 1e-4);
      // same look as the normal sky (skyLook), so nothing pops at the start or the end
      const { size, k } = skyLook(s.star.L, d);
      const c = skyColor(s.star.color, k, this.c);
      hp[i * 3] = lp[i * 6] = rel.x;
      hp[i * 3 + 1] = lp[i * 6 + 1] = rel.y;
      hp[i * 3 + 2] = lp[i * 6 + 2] = rel.z;
      // the tail is where the star appeared a moment ago: further along the direction of travel.
      // Capped below the star's distance so a streak never sweeps through the camera (e.g. the
      // star you're leaving, right behind you).
      const L = Math.min(tail, 0.6 * d);
      lp[i * 6 + 3] = rel.x + st.dir.x * L;
      lp[i * 6 + 4] = rel.y + st.dir.y * L;
      lp[i * 6 + 5] = rel.z + st.dir.z * L;
      const hk = 1 - 0.45 * blur;
      hc[i * 3] = c.r * hk;
      hc[i * 3 + 1] = c.g * hk;
      hc[i * 3 + 2] = c.b * hk;
      hs[i] = size;
      lc[i * 6] = c.r * 1.3;
      lc[i * 6 + 1] = c.g * 1.3;
      lc[i * 6 + 2] = c.b * 1.3;
      lc[i * 6 + 3] = lc[i * 6 + 4] = lc[i * 6 + 5] = 0;
    });
    for (const geo of [this.heads!.geometry, this.trails!.geometry]) for (const k in geo.attributes) geo.attributes[k].needsUpdate = true;
    this.camera.quaternion.copy(q);
    this.camera.aspect = aspect;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    gl.render(this.scene, this.camera);
  }

  private build(j: Jump) {
    this.dispose();
    this.jump = j;
    const mid = j.from.clone().add(j.dest.pos).multiplyScalar(0.5);
    const half = j.from.distanceTo(j.dest.pos) / 2;
    this.stars = systemsNear(mid, SKY_RADIUS + half);
    const N = this.stars.length;
    const heads = new THREE.BufferGeometry();
    heads.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    heads.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    heads.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.heads = new THREE.Points(heads, this.pointsMaterial());
    const trails = new THREE.BufferGeometry();
    trails.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    trails.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 6), 3));
    this.trails = new THREE.LineSegments(trails, new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
    for (const o of [this.heads, this.trails]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }
  }

  dispose() {
    for (const o of [this.heads, this.trails]) {
      if (!o) continue;
      this.scene.remove(o);
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.heads = this.trails = null;
    this.jump = null;
  }
}
