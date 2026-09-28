/*
 * A planetary ring up close (sim/rings.ts, docs/rings.md): the rocks themselves, generated around
 * the camera each frame from the ring's cells and drawn as instanced, lumpy, star-lit rocks (in the
 * planet's shadow where it falls). Two tiers: small rocks close by, boulders further out. Rocks
 * shrink away toward the edge of their tier's range instead of popping, and the ring's flat disc
 * fades out inside that range (ring.frag.glsl, uNearFade), so near you it's rocks and far off it's
 * the disc's bands.
 *
 * Positions are worked out in double precision relative to the planet (rings are ~10⁸ m out) and
 * handed to the GPU relative to the camera, like everything else.
 */
import { mulberry32 } from '../lib/rng';
import { THREE } from '../lib/three';
import { snoise } from '../sim/terrain';
import { hashInts, RING_HALF_THICK, ROCK_TIERS, ringDensity } from '../sim/rings';
import type { World } from '../types';

/** Rock shapes, and how many of each can be drawn at once. */
const VARIANTS = 4,
  CAP = 3000;
/** Above (or below) the belt by this much (m), the disc is back in full around you. */
const FADE_ABOVE = 6000;

const VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vN; varying vec3 vWP; varying vec3 vCol;
void main(){
  mat4 m = modelMatrix * instanceMatrix;
  vN = normalize(mat3(m) * normal);
  vec4 wp = m * vec4(position, 1.0);
  vWP = wp.xyz;
  vCol = instanceColor;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

const FS = `
#include <logdepthbuf_pars_fragment>
uniform vec3 uLight; uniform vec3 uPC; uniform float uPR; uniform float uExp;
varying vec3 vN; varying vec3 vWP; varying vec3 vCol;
void main(){
  #include <logdepthbuf_fragment>
  vec3 L = normalize(uLight);
  // the planet's shadow: behind it, within its radius of the line to the star
  vec3 toP = vWP - uPC;
  float along = dot(toP, L);
  float sh = (along < 0.0 && length(toP - along * L) < uPR) ? 0.0 : 1.0;
  float d = max(dot(normalize(vN), L), 0.0);
  gl_FragColor = vec4(vCol * (d * sh + 0.004) * uExp, 1.0);
}`;

/** A lumpy rock: an icosphere pushed in and out by noise, faceted. */
function rockGeometry(seed: number) {
  const g = new THREE.IcosahedronGeometry(1, 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const k = 1 + 0.32 * snoise(v.x * 1.3 + seed, v.y * 1.3, v.z * 1.3) + 0.12 * snoise(v.x * 3.1, v.y * 3.1 + seed, v.z * 3.1);
    v.multiplyScalar(k);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

const X = new THREE.Vector3(1, 0, 0),
  Z = new THREE.Vector3(0, 0, 1);
const tmpM = new THREE.Matrix4(),
  tmpQ = new THREE.Quaternion(),
  tmpS = new THREE.Vector3(),
  tmpP = new THREE.Vector3(),
  tmpA = new THREE.Vector3(),
  tmpC = new THREE.Color();

export class RingField {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.InstancedMesh[] = [];
  private readonly mat: THREE.ShaderMaterial;
  readonly uni = { uLight: { value: new THREE.Vector3() }, uPC: { value: new THREE.Vector3() }, uPR: { value: 1 }, uExp: { value: 1 } };
  /** How far the flat disc should fade out around the camera (m; 0 when there are no rocks here). */
  nearFade = 0;

  constructor(exp: THREE.IUniform) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { ...this.uni, uExp: exp } });
    for (let k = 0; k < VARIANTS; k++) {
      const m = new THREE.InstancedMesh(rockGeometry(k * 7.3 + 1.1), this.mat, CAP);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
      this.meshes.push(m);
      this.group.add(m);
    }
  }

  /**
   * Show the rocks of `b`'s ring around the camera. `rel` is the planet's centre relative to the
   * camera (m), `n` the ring's normal (the planet's axis), `light` the direction to the star, `t` the
   * sim time. Returns whether any part of the ring is close enough to have rocks.
   */
  update(b: World, rel: THREE.Vector3, n: THREE.Vector3, light: THREE.Vector3, t: number) {
    const ring = b.ring!;
    const R = b.radius;
    const far = ROCK_TIERS[ROCK_TIERS.length - 1].range;
    // the camera in the ring's frame (double precision): height above the plane, radius, angle
    const cx = -rel.x,
      cy = -rel.y,
      cz = -rel.z;
    const h = cx * n.x + cy * n.y + cz * n.z;
    const px = cx - h * n.x,
      py = cy - h * n.y,
      pz = cz - h * n.z;
    const r = Math.hypot(px, py, pz);
    const counts = new Array(VARIANTS).fill(0);
    this.nearFade = 0;
    const active = Math.abs(h) < far + RING_HALF_THICK && r > ring.inner * R - far && r < ring.outer * R + far;
    if (active) {
      // the disc stands for the rocks too small or far to draw: inside the belt the drawn rocks
      // replace it around you; from well above or below it, it shows again (or you'd look down
      // through a hole of sparse boulders)
      const above = Math.max(0, Math.abs(h) - RING_HALF_THICK);
      this.nearFade = far * 0.9 * Math.max(0, 1 - above / FADE_ABOVE);
      // in-plane axes fixed to the ring (not the camera, or the rocks would slide as you move)
      const e1 = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Z).normalize();
      const e2 = new THREE.Vector3().crossVectors(n, e1);
      const c1 = px * e1.x + py * e1.y + pz * e1.z,
        c2 = px * e2.x + py * e2.y + pz * e2.z;
      const thC = Math.atan2(c2, c1); // the camera's angle round the ring
      this.uni.uLight.value.copy(light);
      this.uni.uPC.value.copy(rel);
      this.uni.uPR.value = R;
      const seedI = Math.floor(ring.seed * 1e4);
      ROCK_TIERS.forEach((tier, ti) => {
        const C = tier.cell,
          range = tier.range;
        const iR = Math.ceil(range / C);
        const i0 = Math.floor(r / C);
        const kLo = Math.floor(-RING_HALF_THICK / C),
          kHi = Math.floor(RING_HALF_THICK / C);
        for (let i = i0 - iR; i <= i0 + iR; i++) {
          const rb = (i + 0.5) * C;
          const dr = Math.abs(rb - r) - C / 2;
          if (dr > range) continue;
          const dens = ringDensity(b, rb / R) / 0.85;
          if (dens < 0.01) continue;
          // this radial bin turns at the circular orbit rate at its radius
          const w = Math.sqrt(b.mu / (rb * rb * rb));
          const nth = Math.max(1, Math.floor((2 * Math.PI * rb) / C));
          const dth = (2 * Math.PI) / nth;
          // the camera's angle in this bin's co-orbiting frame
          const phiC = thC - ((w * t) % (2 * Math.PI));
          const jc = Math.floor(phiC / dth);
          const arc = Math.sqrt(Math.max(0, range * range - dr * dr));
          const dj = Math.ceil(arc / (rb * dth)) + 1;
          for (let j = jc - dj; j <= jc + dj; j++) {
            const jj = ((j % nth) + nth) % nth;
            for (let k = kLo; k <= kHi; k++) {
              // the part of this vertical bin inside the ring's thickness
              const z0 = Math.max(k * C, -RING_HALF_THICK),
                z1 = Math.min((k + 1) * C, RING_HALF_THICK);
              if (z1 <= z0) continue;
              const rnd = mulberry32(hashInts(ti, i, jj, k, seedI));
              const expect = tier.perCell * dens * ((z1 - z0) / C);
              const cnt = Math.floor(expect + rnd());
              for (let q = 0; q < cnt; q++) {
                const rr = rb + (rnd() - 0.5) * C;
                const phi = (j + rnd()) * dth + ((w * t) % (2 * Math.PI)); // angle in (e1, e2) now
                const zz = z0 + rnd() * (z1 - z0);
                const cos = Math.cos(phi),
                  sin = Math.sin(phi);
                // camera-relative position: rock − camera, in (e1, e2, n)
                const ax = rr * cos - c1,
                  ay = rr * sin - c2,
                  az = zz - h;
                const dist = Math.hypot(ax, ay, az);
                const size = tier.minR * Math.pow(tier.maxR / tier.minR, Math.pow(rnd(), 2.2));
                const variant = Math.floor(rnd() * VARIANTS);
                const sx = 0.6 + 0.4 * rnd(),
                  sy = 0.55 + 0.45 * rnd(),
                  tint = 0.5 + 0.6 * rnd();
                // a slow tumble about a random axis
                tmpA.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
                const spin = rnd() * 6.28 + t * (0.002 + 0.02 * rnd()) * (20 / size);
                if (dist > range) continue;
                const v = this.meshes[variant];
                const c = counts[variant];
                if (c >= CAP) continue;
                // shrink away toward the edge of the tier's range (no pop-in)
                const s = size * Math.min(1, (range - dist) / (range * 0.15));
                tmpP.copy(e1).multiplyScalar(ax).addScaledVector(e2, ay).addScaledVector(n, az);
                tmpQ.setFromAxisAngle(tmpA, spin);
                tmpS.set(s * sx, s * sy, s);
                v.setMatrixAt(c, tmpM.compose(tmpP, tmpQ, tmpS));
                tmpC.copy(ring.color).multiplyScalar(tint);
                v.setColorAt(c, tmpC);
                counts[variant] = c + 1;
              }
            }
          }
        }
      });
    }
    this.meshes.forEach((m, k) => {
      m.count = counts[k];
      m.visible = counts[k] > 0;
      if (counts[k]) {
        m.instanceMatrix.needsUpdate = true;
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    });
    return active;
  }

  dispose() {
    for (const m of this.meshes) {
      m.geometry.dispose();
      m.dispose();
    }
    this.mat.dispose();
  }
}
