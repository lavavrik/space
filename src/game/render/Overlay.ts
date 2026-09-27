import { JUMP_CHARGE_TIME, RESPAWN_TIME } from '../constants';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { relVel } from '../sim/frame';
import { transitState, type TransitState } from '../sim/hyperspace';
import { galPos, reachable } from '../sim/navigation';
import type { Jump } from '../types';
import type { SceneRenderer } from './SceneRenderer';

const AMB = 'rgba(255,165,58,',
  CYA = 'rgba(127,220,255,',
  MINT = 'rgba(115,255,178,'; // stations (matches STATION_RGB in SceneRenderer)
const MONO = '"Share Tech Mono", monospace';
const SANS = '"Chakra Petch", system-ui, sans-serif';

/** 2D canvas drawn over the 3D view: reticle, markers, labels, and full-screen effects. */
export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 1;
  private H = 1;
  private ui = 1; // HUD scale factor for label sizes
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private transit?: TransitState;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: SceneRenderer,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(W: number, H: number) {
    this.W = W;
    this.H = H;
    // labels follow the HUD's scale (the root font size, 12px at the old design size)
    this.ui = parseFloat(getComputedStyle(document.documentElement).fontSize) / 12 || 1;
    // markers and labels: sharp up to 2×, but no more than ~8 MP, the cost of compositing it every frame
    const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(8.3e6 / Math.max(1, W * H)));
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** A canvas font at `px` design pixels, scaled like the HUD. */
  private font(px: number, family: string, bold = false) {
    return `${bold ? '700 ' : ''}${Math.round(px * this.ui)}px ${family}`;
  }

  /** Project a ship-relative position to screen pixels. */
  private toScreen(g: Game, rel: THREE.Vector3) {
    const { W, H } = this;
    const { pxPerRad } = g.view;
    const v = this.tmp2.copy(rel).applyQuaternion(g.qInv);
    return { x: W / 2 + (v.x / -v.z) * pxPerRad, y: H / 2 - (v.y / -v.z) * pxPerRad, behind: v.z >= 0, v };
  }

  /** Arrow at the edge of the view pointing toward something off-screen. */
  private edgeArrow(v: THREE.Vector3, color: string, label: string) {
    const { ctx, W, H } = this;
    const ang = Math.atan2(-v.y, v.x);
    const cx = W / 2,
      cy = H / 2,
      r = Math.min(W, H) * 0.36;
    const x = cx + Math.cos(ang) * r,
      y = cy + Math.sin(ang) * r;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.fillStyle = color + '0.9)';
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-2, 0);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = color + '0.85)';
    ctx.font = this.font(11, MONO);
    ctx.textAlign = 'center';
    ctx.fillText(label, x, y + 22);
  }

  draw(g: Game) {
    const { ctx, W, H } = this;
    const { ship, jump } = g;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2,
      cy = H / 2;

    if (jump && jump.phase === 'tunnel') {
      this.drawTunnel(jump);
      return;
    }
    if (ship.dead) {
      this.drawDestroyed(ship.dead.t, ship.dead.reason);
      return;
    }

    // FTL vignette
    if (ship.mode === 'ftl') {
      const gr = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.35, cx, cy, Math.hypot(W, H) / 2);
      gr.addColorStop(0, 'rgba(60,140,220,0)');
      gr.addColorStop(1, 'rgba(60,140,220,0.22)');
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, W, H);
    }
    if (jump && jump.phase === 'charge') {
      const gr = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.2, cx, cy, Math.hypot(W, H) / 2);
      gr.addColorStop(0, 'rgba(120,180,255,0)');
      gr.addColorStop(1, `rgba(120,180,255,${0.35 * (1 - jump.t / JUMP_CHARGE_TIME)})`);
      ctx.fillStyle = gr;
      ctx.fillRect(0, 0, W, H);
    }

    this.drawReticle(ship.mode === 'ftl' ? CYA : AMB);

    // prograde marker (where you're going), or retrograde (where you came from) when it's behind
    // you, e.g. flying backwards while decoupled
    const dir = ship.mode === 'normal' ? (g.curSpeed > 2 ? relVel(g) : null) : ship.decoupled ? ship.travelDir.clone() : null;
    if (dir) {
      dir.normalize().multiplyScalar(1000);
      const pro = this.toScreen(g, dir);
      const s = pro.behind ? this.toScreen(g, dir.negate()) : pro;
      if (!s.behind) this.drawVelMarker(s.x, s.y, !pro.behind, ship.mode === 'ftl' ? CYA : AMB);
    }

    this.drawBodies(g);
    this.drawStations(g);
    this.drawReachable(g);
    this.drawJumpDest(g);

    if (g.flash > 0) {
      ctx.fillStyle = `rgba(220,240,255,${g.flash})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /**
   * Hyperspace overlay. The star field itself is drawn in 3D by SceneRenderer (real stars
   * streaking past); this only adds a blue edge glow that swells at the peak speed and a readout.
   */
  private drawTunnel(j: Jump) {
    const { ctx, W, H } = this;
    const cx = W / 2,
      cy = H / 2;
    const st = (this.transit = transitState(j, this.transit));
    const k = Math.sin(Math.PI * st.u); // 0 at both ends, 1 at peak speed
    const gr = ctx.createRadialGradient(cx, cy, Math.min(W, H) * (0.45 - 0.15 * k), cx, cy, Math.hypot(W, H) / 2);
    gr.addColorStop(0, 'rgba(60,120,255,0)');
    gr.addColorStop(1, `rgba(60,120,255,${0.1 + 0.3 * k})`);
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = CYA + '0.9)';
    ctx.font = this.font(12, MONO);
    ctx.fillText(`${j.dest.name.toUpperCase()} · ${st.left.toFixed(2)} LY TO GO`, cx, cy - Math.min(W, H) * 0.3);
  }

  private drawDestroyed(t: number, reason: string) {
    const { ctx, W, H } = this;
    const cx = W / 2,
      cy = H / 2;
    const k = Math.min(1, (RESPAWN_TIME - t) * 3);
    ctx.fillStyle = `rgba(40,6,2,${0.82 * k})`;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(255,91,70,${k})`;
    ctx.font = this.font(34, SANS, true);
    ctx.fillText('SHIP DESTROYED', cx, cy - 30);
    ctx.fillStyle = `rgba(255,230,199,${k})`;
    ctx.font = this.font(15, SANS);
    ctx.fillText(reason, cx, cy + 4);
    ctx.fillStyle = `rgba(255,165,58,${0.8 * k})`;
    ctx.font = this.font(12, MONO);
    ctx.fillText(`RESTORING SHIP IN ${Math.max(0, t).toFixed(1)} S`, cx, cy + 34);
  }

  /** Prograde: a ring with three spikes. Retrograde: a ring with a cross through it. */
  private drawVelMarker(x: number, y: number, prograde: boolean, color: string) {
    const { ctx } = this;
    ctx.strokeStyle = color + '0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    if (prograde) {
      ctx.moveTo(x - 12, y);
      ctx.lineTo(x - 6, y);
      ctx.moveTo(x + 6, y);
      ctx.lineTo(x + 12, y);
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y - 12);
    } else {
      const k = 4.2;
      ctx.moveTo(x - k, y - k);
      ctx.lineTo(x + k, y + k);
      ctx.moveTo(x + k, y - k);
      ctx.lineTo(x - k, y + k);
    }
    ctx.stroke();
  }

  private drawReticle(rc: string) {
    const { ctx, W, H } = this;
    const cx = W / 2,
      cy = H / 2;
    ctx.strokeStyle = rc + '0.75)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx - 16, cy);
    ctx.lineTo(cx - 6, cy);
    ctx.moveTo(cx + 6, cy);
    ctx.lineTo(cx + 16, cy);
    ctx.moveTo(cx, cy - 16);
    ctx.lineTo(cx, cy - 6);
    ctx.moveTo(cx, cy + 6);
    ctx.lineTo(cx, cy + 16);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 34, -0.5, 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, 34, Math.PI - 0.5, Math.PI + 0.5);
    ctx.stroke();
  }

  /** Target brackets, and circles with names on small bodies. */
  private drawBodies(g: Game) {
    const { ctx, W, H } = this;
    const { ship } = g;
    ctx.font = this.font(11, MONO);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const b of g.cur.bodies) {
      const view = this.scene.views.get(b)!;
      const rel = this.tmp.subVectors(b.pos, ship.pos);
      const isT = b === g.target;
      const s = this.toScreen(g, rel);
      const label = () => `${b.name} · ${fmtDist(view.dist - b.radius)}`;
      if (s.behind) {
        if (isT) this.edgeArrow(s.v, AMB, label());
        continue;
      }
      const onScreen = s.x > -50 && s.x < W + 50 && s.y > -50 && s.y < H + 50;
      if (!onScreen) {
        if (isT) this.edgeArrow(s.v, AMB, label());
        continue;
      }
      const pxR = view.pxR;
      const show = b.kind !== 'moon' || isT || b.parent.pos.distanceTo(ship.pos) < b.parent.radius * 250 || pxR > 1.5;
      if (!show) continue;
      const rClamp = Math.min(pxR, Math.max(W, H));
      if (isT) {
        const r = Math.max(14, rClamp + 8);
        const t = 8;
        ctx.strokeStyle = AMB + '0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(s.x + sx * r, s.y + sy * (r - t));
          ctx.lineTo(s.x + sx * r, s.y + sy * r);
          ctx.lineTo(s.x + sx * (r - t), s.y + sy * r);
        }
        ctx.stroke();
        if (r < H * 0.4) {
          ctx.fillStyle = AMB + '1)';
          ctx.fillText(b.name.toUpperCase(), s.x, s.y - r - 8);
          ctx.fillStyle = 'rgba(255,230,199,0.9)';
          ctx.fillText(fmtDist(view.dist - b.radius), s.x, s.y + r + 15);
        }
      } else if (pxR < 18) {
        ctx.strokeStyle = AMB + (b.kind === 'moon' ? '0.35)' : '0.55)');
        ctx.lineWidth = 1;
        const r = Math.max(5, pxR + 4);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = AMB + (b.kind === 'moon' ? '0.5)' : '0.75)');
        ctx.fillText(b.name, s.x, s.y - r - 5);
      }
    }
  }

  /**
   * Stations get a mint square marker whenever you're anywhere near their world, so they stand out
   * against the planets' amber circles; the name shows when closer, and a targeted one gets brackets.
   */
  private drawStations(g: Game) {
    const { ctx, W, H } = this;
    ctx.font = this.font(11, MONO);
    ctx.textAlign = 'center';
    for (const st of g.cur.stations) {
      const view = this.scene.stationViews.get(st);
      if (!view) continue;
      const isT = st === g.target;
      const d = view.dist;
      const label = `${st.name} · ${fmtDist(Math.max(0, d - st.size / 2))}`;
      const s = this.toScreen(g, this.tmp.subVectors(st.pos, g.ship.pos));
      const onScreen = !s.behind && s.x > -50 && s.x < W + 50 && s.y > -50 && s.y < H + 50;
      if (!onScreen) {
        if (isT) this.edgeArrow(s.v, MINT, label);
        continue;
      }
      const near = d < st.parent.radius * 60;
      if (!isT && !near) continue;
      const r = Math.max(7, Math.min(view.pxR, Math.max(W, H)) + 5);
      ctx.strokeStyle = MINT + (isT ? '0.95)' : '0.8)');
      ctx.lineWidth = isT ? 1.5 : 1.2;
      if (isT) {
        const k = 7;
        ctx.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          ctx.moveTo(s.x + sx * (r + 4), s.y + sy * (r + 4 - k));
          ctx.lineTo(s.x + sx * (r + 4), s.y + sy * (r + 4));
          ctx.lineTo(s.x + sx * (r + 4 - k), s.y + sy * (r + 4));
        }
        ctx.stroke();
      }
      if (r < H * 0.4) {
        ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
        if (isT || d < st.parent.radius * 25) {
          ctx.fillStyle = MINT + '0.95)';
          ctx.fillText(isT ? label.toUpperCase() : st.name, s.x, s.y - r - 7);
        }
      }
    }
  }

  /**
   * Small rings on reachable stars near the crosshair, so you can see what N would pick by aiming.
   * Only a narrow cone is marked to keep ~100 in-range stars from cluttering the view.
   */
  private drawReachable(g: Game) {
    const { ctx } = this;
    const gp = galPos(g);
    const dir = this.tmp;
    ctx.font = this.font(10, MONO);
    ctx.textAlign = 'center';
    for (const s of reachable(g)) {
      if (s.id === g.jumpDest?.id) continue;
      dir.subVectors(s.pos, gp);
      const ly = dir.length();
      const p = this.toScreen(g, dir.normalize().multiplyScalar(1e6));
      if (p.behind) continue;
      const off = Math.hypot(p.v.x, p.v.y) / -p.v.z; // tan of angle from the crosshair
      if (off > 0.16) continue;
      const a = off < 0.06 ? 0.75 : 0.3;
      ctx.strokeStyle = CYA + a + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      if (off < 0.06) {
        ctx.fillStyle = CYA + '0.7)';
        ctx.fillText(`${s.name} · ${ly.toFixed(1)} ly`, p.x, p.y - 11);
      }
    }
  }

  /** Diamond on the hyperjump destination star. */
  private drawJumpDest(g: Game) {
    const dest = g.jumpDest;
    if (!dest) return;
    const { ctx, W, H } = this;
    const dir = dest.pos.clone().sub(galPos(g));
    const ly = dir.length();
    const s = this.toScreen(g, dir.normalize().multiplyScalar(1e6));
    const label = `${dest.name} · ${ly.toFixed(2)} ly`;
    if (s.behind || s.x < 0 || s.x > W || s.y < 0 || s.y > H) this.edgeArrow(s.v, CYA, label);
    else {
      ctx.strokeStyle = CYA + '0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - 12);
      ctx.lineTo(s.x + 12, s.y);
      ctx.lineTo(s.x, s.y + 12);
      ctx.lineTo(s.x - 12, s.y);
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = CYA + '0.95)';
      ctx.fillText(label.toUpperCase(), s.x, s.y - 20);
    }
  }
}
