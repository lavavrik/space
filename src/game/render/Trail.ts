/*
 * An FTL trail as a real trail: the path the ship actually flew in FTL, as a polyline of recorded
 * positions (system frame), fading with age. So it grows out from where the drive started (it used
 * to appear at once at full length: one straight line of TRAIL_S seconds at the current speed), it
 * bends where the ship turned (the straight line swung round with the ship), and after drop-out it
 * stays where it was laid and fades away.
 *
 * Samples are taken every SAMPLE_S, and whenever the course has turned TURN since the last one, so
 * straight runs cost few points and turns stay smooth. It's cut at TRAIL_S of age and TRAIL_MAX of
 * length, and brightness falls to nothing toward either.
 */
import { THREE } from '../lib/three';
import { AU } from '../constants';

/** A trail fades out over this many seconds of age, and this length (m). */
export const TRAIL_S = 30,
  TRAIL_MAX = 0.2 * AU;
const SAMPLE_S = 0.5,
  TURN = 0.01, // rad
  MAX_PTS = 128;

export class FtlTrail {
  /** The line to draw, camera-relative (filled by draw): positions, fades 0…1, and how many. */
  readonly pos = new Float32Array((MAX_PTS + 2) * 3);
  readonly fade = new Float32Array(MAX_PTS + 2);
  count = 0;
  visible = false;
  /** Recorded positions (system frame) and when, oldest first. */
  private readonly pts: { p: THREE.Vector3; t: number }[] = [];
  private readonly lastDir = new THREE.Vector3();
  private active = false;
  private readonly head = new THREE.Vector3();

  /** Each frame: the ship at `pos` (system frame) flying along `dir`, in FTL (`on`) or not, at sim time t. */
  record(pos: THREE.Vector3, dir: THREE.Vector3, on: boolean, t: number) {
    const last = this.pts[this.pts.length - 1];
    if (on) {
      if (!this.active || !last || t - last.t >= SAMPLE_S || dir.angleTo(this.lastDir) > TURN) {
        this.pts.push({ p: pos.clone(), t });
        this.lastDir.copy(dir);
      }
      this.head.copy(pos);
    } else if (this.active) this.pts.push({ p: pos.clone(), t }); // where it dropped out: the trail ends here
    this.active = on;
    while (this.pts.length && t - this.pts[0].t > TRAIL_S) this.pts.shift();
    if (this.pts.length > MAX_PTS) this.pts.splice(0, this.pts.length - MAX_PTS);
  }

  /** Start afresh (a new system: the old positions mean nothing here). */
  clear() {
    this.pts.length = 0;
    this.active = false;
  }

  /**
   * Fill the line (pos, fade, count), camera-relative to `cam` (system frame), at sim time t. `headAt` moves the head
   * vertex (your own trail starts a little behind the camera, not in the eye).
   */
  draw(cam: THREE.Vector3, t: number, headAt?: THREE.Vector3) {
    const { pos, fade } = this;
    let n = 0,
      len = 0;
    const prev = new THREE.Vector3();
    const put = (p: THREE.Vector3, age: number) => {
      if (n) len += p.distanceTo(prev);
      prev.copy(p);
      const rel = p.clone().sub(cam);
      pos.set([rel.x, rel.y, rel.z], n * 3);
      fade[n++] = Math.max(0, Math.min(1 - age / TRAIL_S, 1 - len / TRAIL_MAX));
      return len < TRAIL_MAX;
    };
    let go = true;
    if (this.active) go = put(headAt ? headAt.clone().add(cam) : this.head, 0);
    for (let i = this.pts.length - 1; i >= 0 && go; i--) go = put(this.pts[i].p, t - this.pts[i].t);
    this.count = n;
    this.visible = n >= 2;
  }
}
