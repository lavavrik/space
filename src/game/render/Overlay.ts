import { threatNow } from '../sim/belt';
import { rockLabel } from '../sim/ringRocks';
import { SystemMap } from './SystemMap';
import { occluder } from '../sim/sight';
import { surfaceDist } from '../sim/terrain';
import { JUMP_CHARGE_TIME, RESPAWN_TIME } from '../constants';
import { fmtDist } from '../format';
import type { Game } from '../Game';
import { massLockExit } from '../sim/ftl';
import { THREE } from '../lib/three';
import { relVel } from '../sim/frame';
import { transitState, type TransitState } from '../sim/hyperspace';
import { scanProgress } from '../sim/scanner';
import { galPos, hiddenBy, occluders, reachable } from '../sim/navigation';
import type { Jump, Npc, StarSystem } from '../types';
import type { GameRenderer } from './api';
import { PAD_R, SLOT_H, SLOT_W, toWorld } from '../sim/stationGeom';
import { padWorld } from '../sim/docking';
import { contactLabel, known } from '../sim/radar';
import { liveProspects, prospectNow } from '../sim/prospect';
import { wreckMetal, wrecksHere } from '../sim/wreck';
/** Prospect markers' colours by the rock's metal (rgba prefixes). */
const PROSPECT_COL = { icy: 'rgba(255,230,199,', 'nickel-iron': 'rgba(200,190,175,', 'cobalt-rich': 'rgba(110,160,255,', 'platinum-rich': 'rgba(255,215,120,' } as const;

const AMB = 'rgba(255,165,58,',
  CYA = 'rgba(127,220,255,',
  MINT = 'rgba(115,255,178,', // stations (matches STATION_RGB in render/look.ts)
  RED = 'rgba(255,91,70,'; // warnings (the mass lock's way out)
/** The HUD's one typeface (no monospace: see styles/theme.css). */
const SANS = '"Chakra Petch", system-ui, sans-serif';

/** 2D canvas drawn over the 3D view: reticle, markers, labels, and full-screen effects. */
/** Other ships get a label within this distance (m). */
const TRAFFIC_LABEL = 5e8;
/** At most this many ships labelled, the nearest (a busy system has a couple of hundred). */
const TRAFFIC_LABELS = 16;

/**
 * Every label drawn on the overlay (and the system map, which shares its canvas) gets a dark
 * outline under it, so it reads over a bright world or a sunlit cloud deck as well as against space.
 * Done once, on the context: its fillText strokes the same text first (round joins, ~3 px). The
 * outline fades with the text (its alpha follows the fill colour's, parsed from rgba()).
 */
function outlineText(ctx: CanvasRenderingContext2D, ui: () => number) {
  const fill = ctx.fillText.bind(ctx);
  ctx.fillText = (text: string, x: number, y: number, maxWidth?: number) => {
    const m = /rgba?\([^,]+,[^,]+,[^,)]+(?:,\s*([\d.]+))?\)/.exec(String(ctx.fillStyle));
    const a = m?.[1] !== undefined ? +m[1] : 1;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 * ui();
    ctx.strokeStyle = `rgba(0, 0, 0, ${(0.7 * a * ctx.globalAlpha).toFixed(3)})`;
    ctx.globalAlpha = 1;
    ctx.strokeText(text, x, y, maxWidth);
    ctx.restore();
    fill(text, x, y, maxWidth);
  };
}

export class Overlay {
  private readonly ctx: CanvasRenderingContext2D;
  private W = 1;
  private H = 1;
  private ui = 1; // HUD scale factor for label sizes
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private transit?: TransitState;

  /** The system map (Shift+O), drawn on this canvas in place of the flight HUD while it's open. */
  readonly map: SystemMap;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly scene: GameRenderer,
  ) {
    this.ctx = canvas.getContext('2d')!;
    outlineText(this.ctx, () => this.ui);
    this.map = new SystemMap(this.ctx, () => this.ui);
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
  /**
   * Docking guidance while a pad is granted: the slot's outline on the station (it turns with the
   * station, so you can match its roll) and a marker on your pad with its number and distance.
   */
  private drawDocking(g: Game) {
    const d = g.dock;
    if (!d || d.docked) return;
    const { ctx } = this;
    const st = d.station;
    ctx.save();
    ctx.lineWidth = 1.5 * this.ui;
    // slot outline, a little outside the opening
    const sx = SLOT_W / 2 + 0.01,
      sy = SLOT_H / 2 + 0.01;
    const pts = [
      [-sx, -sy],
      [sx, -sy],
      [sx, sy],
      [-sx, sy],
    ].map(([x, y]) => this.toScreen(g, toWorld(st, g.simTime, new THREE.Vector3(x, y, 0.5)).sub(g.ship.pos)));
    // (a sky station has no slot: you come down onto the pad from above)
    if (!st.sky && !g.inStation && pts.every((p) => !p.behind)) {
      ctx.strokeStyle = MINT + '0.85)';
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      const c = pts.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
      ctx.fillStyle = MINT + '0.9)';
      ctx.font = this.font(12, SANS);
      ctx.textAlign = 'center';
      ctx.fillText('SLOT', c.x, Math.min(...pts.map((p) => p.y)) - 8 * this.ui);
    }
    // the pad
    const pw = padWorld(g)!;
    const rel = pw.clone().sub(g.ship.pos);
    const s = this.toScreen(g, rel);
    const label = `PAD ${d.pad + 1} · ${fmtDist(rel.length())}`;
    if (s.behind) this.edgeArrow(s.v, AMB, label);
    else {
      const r = Math.max(8 * this.ui, ((PAD_R * st.size) / rel.length()) * g.view.pxPerRad);
      ctx.strokeStyle = AMB + '0.95)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = AMB + '0.95)';
      ctx.font = this.font(12, SANS);
      ctx.textAlign = 'center';
      ctx.fillText(label, s.x, s.y - r - 6 * this.ui);
    }
    ctx.restore();
  }

  /**
   * Periscope (Z): darken everything outside a circular field, with a graduated rim and the
   * magnification and field of view. Fades in with the zoom.
   */
  private drawPeriscope(g: Game) {
    const z = g.zoom.cur;
    if (z < 1.05) return;
    const { ctx, W, H } = this;
    const a = Math.min(1, Math.log(z) / Math.log(4)); // fully in by 4×
    const cx = W / 2,
      cy = H / 2,
      R = Math.min(W, H) * 0.46;
    ctx.save();
    ctx.fillStyle = `rgba(0,0,0,${0.78 * a})`;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, R, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = AMB + 0.55 * a + ')';
    ctx.lineWidth = 1.5 * this.ui;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    // rim ticks every 10°, longer every 30°
    for (let d = 0; d < 360; d += 10) {
      const t = (d * Math.PI) / 180,
        L = (d % 30 === 0 ? 10 : 5) * this.ui;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(t) * R, cy + Math.sin(t) * R);
      ctx.lineTo(cx + Math.cos(t) * (R - L), cy + Math.sin(t) * (R - L));
      ctx.stroke();
    }
    ctx.fillStyle = AMB + 0.9 * a + ')';
    ctx.font = this.font(13, SANS);
    ctx.textAlign = 'center';
    const fov = g.fov;
    ctx.fillText(`PERISCOPE ${Math.round(z)}×  ·  FIELD ${fov < 1 ? (fov * 60).toFixed(1) + '′' : fov.toFixed(1) + '°'}`, cx, Math.max(14 * this.ui, cy - R - 10 * this.ui)); // above the field, clear of the flight panel
    ctx.restore();
  }

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
    ctx.font = this.font(11, SANS);
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
    if (g.map.open) {
      this.map.draw(g, W, H);
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

    this.drawPeriscope(g);
    this.drawDocking(g);
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

    this.drawLockExit(g);
    this.drawBodies(g);
    this.drawStations(g);
    this.drawTraffic(g);
    this.drawProspects(g);
    this.drawWrecks(g);
    this.drawRockThreat(g);
    this.drawLaserTarget(g);
    this.drawReachable(g);
    this.drawJumpDest(g);
    this.drawNavDest(g);
    this.drawNavHover(g);

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
    ctx.font = this.font(12, SANS);
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
    ctx.font = this.font(12, SANS);
    ctx.fillText(`RESTORING SHIP IN ${Math.max(0, t).toFixed(1)} S`, cx, cy + 34);
  }

  /**
   * Mass lock: the way out (sim/ftl.ts massLockExit), straight away from the world holding you,
   * with the height still to climb; an edge arrow when it's off screen. Normal space only.
   */
  private drawLockExit(g: Game) {
    const { ship } = g;
    if (ship.mode !== 'normal' || g.jump || g.dock?.docked || g.inStation) return;
    const exit = massLockExit(g);
    if (!exit) return;
    const label = `LOCK EXIT · CLIMB ${fmtDist(exit.climb)}`;
    const s = this.toScreen(g, this.tmp.copy(exit.dir).multiplyScalar(1000));
    const { W, H } = this;
    if (s.behind || s.x < 0 || s.x > W || s.y < 0 || s.y > H) {
      this.edgeArrow(s.v, RED, label);
      return;
    }
    const { ctx } = this;
    this.drawExitMarker(s.x, s.y);
    ctx.fillStyle = RED + '0.85)';
    ctx.font = this.font(10, SANS);
    ctx.textAlign = 'center';
    ctx.fillText(label, s.x, s.y + 26);
  }

  /** The lock exit marker: a ring with a dot and three arrowheads pointing out (up, and down either side). */
  private drawExitMarker(x: number, y: number) {
    const { ctx } = this;
    ctx.strokeStyle = RED + '0.9)';
    ctx.fillStyle = RED + '0.9)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fill();
    for (const a of [-Math.PI / 2, Math.PI / 6, (5 * Math.PI) / 6]) {
      const c = Math.cos(a),
        s = Math.sin(a);
      // a short stalk from the ring and an arrowhead at its end, pointing outward
      ctx.beginPath();
      ctx.moveTo(x + c * 7, y + s * 7);
      ctx.lineTo(x + c * 12, y + s * 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + c * 16, y + s * 16);
      ctx.lineTo(x + c * 11 - s * 3.5, y + s * 11 + c * 3.5);
      ctx.lineTo(x + c * 11 + s * 3.5, y + s * 11 - c * 3.5);
      ctx.closePath();
      ctx.fill();
    }
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
    ctx.font = this.font(11, SANS);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const b of g.cur.bodies) {
      const view = this.scene.bodyView(b) ?? { dist: b.pos.distanceTo(g.ship.pos), pxR: 0 };
      const rel = this.tmp.subVectors(b.pos, ship.pos);
      const isT = b === g.target;
      // nothing to mark until the radar has found it (the target is always marked)
      if (!isT && !known(g, b)) continue;
      const s = this.toScreen(g, rel);
      const name = contactLabel(g, b);
      const label = () => `${name} · ${fmtDist(surfaceDist(b, ship.pos))}`;
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
        this.drawScanArc(g, s.x, s.y, r + 6);
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
          if (g.showNames) ctx.fillText(name.toUpperCase(), s.x, s.y - r - 8);
          ctx.fillStyle = 'rgba(255,230,199,0.9)';
          ctx.fillText(fmtDist(surfaceDist(b, ship.pos)), s.x, s.y + r + 15);
        }
      } else if (pxR < 18) {
        ctx.strokeStyle = AMB + (b.kind === 'moon' ? '0.35)' : '0.55)');
        ctx.lineWidth = 1;
        const r = Math.max(5, pxR + 4);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = AMB + (b.kind === 'moon' ? '0.5)' : '0.75)');
        if (g.showNames) ctx.fillText(name, s.x, s.y - r - 5);
      }
    }
  }

  /**
   * Stations get a mint square marker whenever you're anywhere near their world, so they stand out
   * against the planets' amber circles; the name shows when closer, and a targeted one gets brackets.
   */
  private drawStations(g: Game) {
    const { ctx, W, H } = this;
    ctx.font = this.font(11, SANS);
    ctx.textAlign = 'center';
    for (const st of g.cur.stations) {
      const view = this.scene.stationView(st);
      if (!view) continue;
      const isT = st === g.target;
      if (!isT && !known(g, st)) continue;
      const d = view.dist;
      const stName = contactLabel(g, st);
      const label = `${stName} · ${fmtDist(Math.max(0, d - st.size / 2))}`;
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
      if (isT) this.drawScanArc(g, s.x, s.y, r + 10);
      if (r < H * 0.4) {
        ctx.strokeRect(s.x - r, s.y - r, 2 * r, 2 * r);
        // on the far side of a world: crossed out, so you know it isn't the lights you see there
        if (occluder(g.cur.bodies, g.ship.pos, st.pos)) {
          ctx.beginPath();
          ctx.moveTo(s.x - r, s.y - r);
          ctx.lineTo(s.x + r, s.y + r);
          ctx.moveTo(s.x + r, s.y - r);
          ctx.lineTo(s.x - r, s.y + r);
          ctx.stroke();
        }
        if (g.showNames && (isT || d < st.parent.radius * 25)) {
          ctx.fillStyle = MINT + '0.95)';
          ctx.fillText(isT ? label.toUpperCase() : stName, s.x, s.y - r - 7);
        }
      }
    }
  }

  /**
   * The rock the mining laser is on (sim/laser.ts): an amber ring round it, with its size, distance,
   * make-up and how much of it is mined away.
   */
  private drawLaserTarget(g: Game) {
    const h = g.laser.hit;
    if (!h) return;
    const { ctx } = this;
    const rel = this.tmp.copy(h.center).add(g.frameBody.pos).sub(g.ship.pos);
    const s = this.toScreen(g, rel);
    if (s.behind) return;
    const d = rel.length();
    const r = Math.max(14 * this.ui, ((h.size * 1.1) / d) * g.view.pxPerRad);
    ctx.save();
    ctx.strokeStyle = AMB + '0.8)';
    ctx.lineWidth = 1.5 * this.ui;
    // corner ticks, like a target's brackets
    const k = Math.min(r * 0.5, 14 * this.ui);
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(s.x + sx * r, s.y + sy * (r - k));
      ctx.lineTo(s.x + sx * r, s.y + sy * r);
      ctx.lineTo(s.x + sx * (r - k), s.y + sy * r);
    }
    ctx.stroke();
    const m = h.make;
    const pct = (x: number) => (x < 0.01 ? (x * 100).toFixed(1) : Math.round(x * 100).toString());
    const mined = 1 - (h.size / h.size0) ** 3;
    const lines = [
      `ROCK ${rockLabel(h.size)} · ${fmtDist(Math.max(0, h.dist))}`,
      ...(m.kind !== 'icy' ? [`METAL-RICH · ${m.kind.toUpperCase()}`] : []),
      `ICE ${pct(m.ice)} % · SILICATE ${pct(m.rock)} % · METAL ${pct(m.metal)} %`,
      `METAL: NI-FE ${pct(m.mix.nife)} % · CO ${pct(m.mix.cobalt)} % · PGM ${pct(m.mix.pgm)} %`,
      ...(mined > 0.005 ? [`MINED ${Math.round(mined * 100)} %`] : []),
    ];
    ctx.font = this.font(11, SANS);
    ctx.textAlign = 'left';
    ctx.fillStyle = AMB + '0.95)';
    lines.forEach((t, i) => ctx.fillText(t, s.x + r + 8 * this.ui, s.y - r + 10 * this.ui + i * 14 * this.ui));
    ctx.restore();
  }

  /**
   * The collision radar's threat (sim/belt.ts): a red ring round the rock on a collision course, with
   * its size and the time to contact (an edge arrow when it's off screen).
   */
  private drawRockThreat(g: Game) {
    const th = g.rockThreat;
    if (!th) return;
    const { ctx } = this;
    const now = threatNow(g, th);
    const rel = this.tmp.copy(now.pos).add(g.frameBody.pos).sub(g.ship.pos);
    const d = rel.length();
    // (its distance too: in empty space nothing else tells you how big a rock is)
    const label = `ROCK ${rockLabel(th.size)} · ${fmtDist(Math.max(0, d - th.size))} · ${Math.max(0, now.t).toFixed(1)} s`;
    const s = this.toScreen(g, rel);
    if (s.behind || s.x < 0 || s.x > this.W || s.y < 0 || s.y > this.H) {
      this.edgeArrow(s.v, RED, label);
      return;
    }
    const r = Math.max(10 * this.ui, ((th.size * 0.8) / d) * g.view.pxPerRad + 6 * this.ui);
    const blink = 0.55 + 0.45 * Math.sin(performance.now() / 90);
    ctx.save();
    ctx.strokeStyle = RED + blink.toFixed(2) + ')';
    ctx.lineWidth = 2 * this.ui;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = RED + '0.95)';
    ctx.font = this.font(12, SANS);
    ctx.textAlign = 'center';
    ctx.fillText(label, s.x, s.y - r - 7 * this.ui);
    ctx.restore();
  }

  /**
   * The radar's metal-rich finds (sim/prospect.ts): a small diamond on each, coloured by its metal
   * (grey nickel-iron, blue cobalt, gold platinum), with its kind, size and distance (names on).
   * Off screen they aren't shown: the radar window lists them.
   */
  private drawProspects(g: Game) {
    const finds = liveProspects(g);
    if (!finds.length) return;
    const { ctx, W, H } = this;
    ctx.save();
    ctx.font = this.font(10, SANS);
    ctx.textAlign = 'left';
    ctx.lineWidth = 1.5 * this.ui;
    for (const [i, p] of finds.entries()) {
      const rel = this.tmp.copy(prospectNow(g, p, this.tmp)).add(g.frameBody.pos).sub(g.ship.pos);
      const d = rel.length();
      const s = this.toScreen(g, rel);
      if (s.behind || s.x < 0 || s.x > W || s.y < 0 || s.y > H) continue;
      const r = Math.max(6 * this.ui, ((p.size * 0.9) / d) * g.view.pxPerRad + 4 * this.ui);
      const col = PROSPECT_COL[p.kind];
      ctx.strokeStyle = col + '0.9)';
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - r);
      ctx.lineTo(s.x + r, s.y);
      ctx.lineTo(s.x, s.y + r);
      ctx.lineTo(s.x - r, s.y);
      ctx.closePath();
      ctx.stroke();
      if (g.showNames) {
        ctx.fillStyle = col + '0.9)';
        ctx.fillText(`${i + 1} · ${p.kind.toUpperCase()} ${rockLabel(p.size)} · ${fmtDist(Math.max(0, d - p.size))}`, s.x + r + 5 * this.ui, s.y + 3 * this.ui);
      }
    }
    ctx.restore();
  }

  /**
   * Other ships (sim/traffic.ts) the radar has found: a small label by each within TRAFFIC_LABEL,
   * and the targeted one in a triangle (bodies get circles, stations squares) with its name, or an
   * edge arrow when it's off screen.
   */
  private drawTraffic(g: Game) {
    const { ctx, W, H } = this;
    ctx.font = this.font(10, SANS);
    // the nearest found ones not sitting on a pad (inside a station) get labels, and the target
    const near = g.traffic
      .filter((n) => n.task !== 'docked' && known(g, n))
      .map((n) => [n, n.pos.distanceToSquared(g.ship.pos)] as const)
      .sort((a, b) => a[1] - b[1])
      .slice(0, TRAFFIC_LABELS)
      .map(([n]) => n);
    if (g.target?.kind === 'ship' && !near.includes(g.target as Npc)) near.push(g.target as Npc);
    for (const npc of near) {
      const isT = npc === g.target;
      if (occluder(g.cur.bodies, g.ship.pos, npc.pos)) continue; // behind a world: not seen at all
      const rel = this.tmp.subVectors(npc.pos, g.ship.pos);
      const d = rel.length();
      const s = this.toScreen(g, rel);
      const onScreen = !s.behind && s.x > 0 && s.x < W && s.y > 0 && s.y < H;
      const name = contactLabel(g, npc);
      const ftl = npc.ftl;
      const text = `${name} · ${ftl ? 'FTL' : fmtDist(d)}`;
      if (!onScreen) {
        if (isT) this.edgeArrow(s.v, CYA, text);
        continue;
      }
      if (isT) {
        const r = 11;
        ctx.strokeStyle = CYA + '0.95)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r * 0.87, s.y + r * 0.5);
        ctx.lineTo(s.x - r * 0.87, s.y + r * 0.5);
        ctx.closePath();
        ctx.stroke();
        this.drawScanArc(g, s.x, s.y, r + 8);
        ctx.fillStyle = CYA + '0.95)';
        ctx.textAlign = 'center';
        if (g.showNames) ctx.fillText(text.toUpperCase(), s.x, s.y - r - 8);
        continue;
      }
      if (d > TRAFFIC_LABEL || !g.showNames) continue;
      ctx.fillStyle = ftl ? 'rgba(127,220,255,0.85)' : 'rgba(255,230,199,0.7)';
      ctx.textAlign = 'left';
      ctx.fillText(text, s.x + 8, s.y - 6);
    }
  }

  /**
   * Your lost ships' wrecks (sim/wreck.ts): their distress beacons, a blinking red × with the metal
   * aboard and the distance, from anywhere in the system (and an edge arrow while one is targeted
   * and off screen). Hidden behind a world, like a ship.
   */
  private drawWrecks(g: Game) {
    const finds = wrecksHere(g);
    if (!finds.length) return;
    const { ctx, W, H } = this;
    const { ship } = g;
    const blink = 0.55 + 0.45 * Math.sin(performance.now() / 260);
    ctx.save();
    ctx.font = this.font(11, SANS);
    ctx.lineWidth = 2 * this.ui;
    for (const w of finds) {
      if (occluder(g.cur.bodies, ship.pos, w.pos)) continue;
      const rel = this.tmp.subVectors(w.pos, ship.pos);
      const d = rel.length();
      const s = this.toScreen(g, rel);
      const text = `WRECK · ${(wreckMetal(w) / 1000).toFixed(1)} T · ${fmtDist(Math.max(0, d - w.radius))}`;
      const isT = g.target === w;
      if (s.behind || s.x < 0 || s.x > W || s.y < 0 || s.y > H) {
        if (isT) this.edgeArrow(s.v, RED, text);
        continue;
      }
      const r = (isT ? 9 : 6) * this.ui;
      ctx.strokeStyle = RED + blink.toFixed(2) + ')';
      ctx.beginPath();
      ctx.moveTo(s.x - r, s.y - r);
      ctx.lineTo(s.x + r, s.y + r);
      ctx.moveTo(s.x + r, s.y - r);
      ctx.lineTo(s.x - r, s.y + r);
      ctx.stroke();
      if (isT) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 6 * this.ui, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (g.showNames || isT) {
        ctx.fillStyle = RED + '0.95)';
        ctx.textAlign = 'left';
        ctx.fillText(text, s.x + r + 6 * this.ui, s.y + 4 * this.ui);
      }
    }
    ctx.restore();
  }

  /** While the target is being scanned, a cyan arc around it fills clockwise with the scan progress. */
  private drawScanArc(g: Game, x: number, y: number, r: number) {
    const t = g.scanning;
    if (!t || t !== g.target) return;
    const { ctx } = this;
    const p = scanProgress(g, t);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = CYA + '0.25)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = CYA + '0.95)';
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Small rings on reachable stars near the crosshair, so you can see what N would pick by aiming.
   * Only a narrow cone is marked to keep ~100 in-range stars from cluttering the view.
   */
  private drawReachable(g: Game) {
    const { ctx } = this;
    const gp = galPos(g);
    const dir = this.tmp;
    ctx.font = this.font(10, SANS);
    ctx.textAlign = 'center';
    const occ = occluders(g);
    for (const s of reachable(g)) {
      if (s.id === g.jumpDest?.id) continue;
      dir.subVectors(s.pos, gp);
      const ly = dir.length();
      if (hiddenBy(occ, dir.normalize())) continue; // behind a planet or moon: not shown, not pickable
      const p = this.toScreen(g, dir.multiplyScalar(1e6));
      if (p.behind) continue;
      const off = Math.hypot(p.v.x, p.v.y) / -p.v.z; // tan of angle from the crosshair
      if (off > 0.16) continue;
      const a = off < 0.06 ? 0.75 : 0.3;
      ctx.strokeStyle = CYA + a + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.stroke();
      if (off < 0.06 && g.showNames) {
        ctx.fillStyle = CYA + '0.7)';
        ctx.fillText(`${s.name} · ${ly.toFixed(1)} ly`, p.x, p.y - 11);
      }
    }
  }

  /** Route waypoints (nav computer): numbered double diamonds on their stars, arrows when off-screen. */
  private drawNavDest(g: Game) {
    const pts = g.navPoints;
    if (!pts.length) return;
    const { ctx, W, H } = this;
    const gp = galPos(g);
    ctx.font = this.font(11, SANS);
    ctx.textAlign = 'center';
    pts.forEach((p, i) => {
      const dir = p.pos.clone().sub(gp);
      const ly = dir.length();
      const s = this.toScreen(g, dir.normalize().multiplyScalar(1e6));
      const last = i === pts.length - 1;
      const label = `${i + 1} · ${p.name} · ${ly.toFixed(1)} ly`;
      if (s.behind || s.x < 0 || s.x > W || s.y < 0 || s.y > H) {
        if (last) this.edgeArrow(s.v, CYA, `ROUTE ${label}`);
        return;
      }
      ctx.strokeStyle = CYA + (last ? '0.95)' : '0.6)');
      ctx.lineWidth = 1.2;
      for (const k of last ? [10, 16] : [9]) {
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - k);
        ctx.lineTo(s.x + k, s.y);
        ctx.lineTo(s.x, s.y + k);
        ctx.lineTo(s.x - k, s.y);
        ctx.closePath();
        ctx.stroke();
      }
      ctx.fillStyle = CYA + (last ? '0.95)' : '0.7)');
      ctx.fillText(label, s.x, s.y + 28);
    });
  }

  /**
   * With the nav panel open and the mouse free, the star under the cursor (within 14 px) gets a
   * ring and its name, type and distance, so you can see what a click would add to the route.
   */
  private drawNavHover(g: Game) {
    const m = g.input.mouse;
    if (!g.navPanel || g.pointerLocked || !m.over || g.route?.running) return;
    const gp = galPos(g);
    const { ctx } = this;
    let best: StarSystem | null = null,
      bestD = 14,
      bx = 0,
      by = 0;
    const occ = occluders(g);
    for (const s of g.sky) {
      if (s.id === g.cur.sys.id) continue;
      const p = this.toScreen(g, this.tmp.subVectors(s.pos, gp).normalize().multiplyScalar(1e6));
      if (p.behind) continue;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      if (d < bestD && hiddenBy(occ, this.tmp.normalize())) continue; // hidden behind a body
      if (d < bestD) {
        bestD = d;
        best = s;
        bx = p.x;
        by = p.y;
      }
    }
    if (!best) return;
    const from = g.navPoints[g.navPoints.length - 1];
    ctx.strokeStyle = CYA + '0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(bx, by, 9, 0, Math.PI * 2);
    ctx.stroke();
    // label on the side away from the right-hand panels
    const left = bx > this.W * 0.5;
    const lx = left ? bx - 14 : bx + 14;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.fillStyle = CYA + '1)';
    ctx.font = this.font(12, SANS);
    ctx.fillText(`${best.name} · ${best.star.spec}`, lx, by - 4);
    ctx.fillStyle = CYA + '0.75)';
    ctx.font = this.font(11, SANS);
    const dist = `${best.pos.distanceTo(gp).toFixed(1)} ly${from ? ` · ${best.pos.distanceTo(from.pos).toFixed(1)} ly from ${from.name}` : ''}`;
    ctx.fillText(`${dist} · click to add`, lx, by + 12);
  }

  /** Diamond on the hyperjump destination star. */
  private drawJumpDest(g: Game) {
    const dest = g.jump?.dest ?? g.jumpDest; // a jump under way keeps its marker
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
