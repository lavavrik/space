import { FOV, HUD_INTERVAL, JUMP_RANGE, MSG_TIME, SHIP, SKY_RADIUS } from './constants';
import { buildSnapshot } from './hud/snapshot';
import { HudStore } from './hud/HudStore';
import { onPress, onRepeat, onWheel } from './input/controls';
import { Input } from './input/Input';
import { THREE } from './lib/three';
import { Overlay } from './render/Overlay';
import { defaultAvionics } from './avionics/catalog';
import { PerfMonitor } from './debug/Perf';
import { SceneRenderer } from './render/SceneRenderer';
import type { Guide } from './sim/guide';
import { pickAt, placeAtHome } from './sim/navigation';
import { closePlanner, openPlanner, requestDisengage } from './sim/planner';
import { update } from './sim/update';
import type { Body, CurrentSystem, Jump, Message, MsgKind, Planner, Power, Ship, StarSystem, Station, Target } from './types';
import { systemsNear } from './universe/galaxy';
import { advanceBodies } from './sim/frame';
import { updateBodies } from './sim/kepler';
import { updateStations } from './sim/stations';
import { buildStations } from './universe/stations';
import { buildSystem } from './universe/system';

const qa = new THREE.Quaternion();
const AY = new THREE.Vector3(0, 1, 0);

function newShip(): Ship {
  return {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(),
    mode: 'normal', throttle: 0, cruise: false, ftlSpooled: false, ftlSpeed: 0, ftlCharge: 0, vmax: 0,
    fa: true, decoupled: false, travelDir: new THREE.Vector3(0, 0, -1), ap: null, landed: null, dead: null, grav: null,
    prop: SHIP.propCap, exotic: SHIP.exoticCap, batt: SHIP.battCap,
    burnRate: 0, sunTrack: false, tanker: null, scoop: '', avionics: defaultAvionics(),
  };
}

/**
 * Owns all game state and runs the frame loop: simulate, render the 3D scene, draw the 2D
 * overlay, and publish a HUD snapshot for React. Simulation, rendering and HUD logic live in
 * their own modules as functions of this object.
 */
export class Game {
  cur!: CurrentSystem;
  /** Systems around the current one that a jump could reach (with a margin for moving within it). */
  nearby: StarSystem[] = [];
  readonly ship = newShip();
  readonly power: Power = { solar: 0, cos: 0, shadow: null, draw: 0, net: 0, thrustKW: 0, ftlKW: 0, chargeKW: 0, burn: 0, flux: 0 };
  target: Target | null = null;
  /** Station whose frame flight assist works in, or null for the system frame (see sim/frame.ts). */
  refFrame: Station | null = null;
  /** Body whose frame ship.vel is in: the one whose sphere of influence the ship is in (see sim/frame.ts). */
  frameBody!: Body;
  jumpDest: StarSystem | null = null;
  jump: Jump | null = null;
  planner: Planner | null = null;
  guide: Guide | null = null;

  simTime = 0;
  curSpeed = 0;
  nearest: Body | null = null;
  nearestAlt = Infinity;
  flash = 0;
  warned: Record<string, boolean> = {};
  msg: Message = { text: '', kind: '', on: false, t: 0 };

  started = false;
  helpVisible = false; // Tab opens the controls; the start screen lists the keys
  /** Body info panel (I), shown in place of the controls list while open. */
  infoVisible = false;
  /** Avionics panel (U): the fitted computers; shares the left column with info and controls. */
  avionicsVisible = false;
  /** Draw the planned / autopilot orbit as a ring (L). */
  orbitPreview = true;
  /** Autopilot status panel (O while the autopilot flies). */
  apPanel = false;
  /** Seconds left to confirm disengaging the autopilot (0 = not armed). */
  apConfirm = 0;
  pointerLocked = false;

  /** Inverse ship orientation and forward vector, refreshed each simulation step. */
  readonly qInv = new THREE.Quaternion();
  readonly fwd = new THREE.Vector3();
  view = { W: 1, H: 1, pxPerRad: 1 };

  readonly hud = new HudStore();
  readonly input: Input;
  private readonly scene: SceneRenderer;
  readonly perf: PerfMonitor;
  private readonly overlay: Overlay;
  private readonly glCanvas: HTMLCanvasElement;
  private readonly overlayCanvas: HTMLCanvasElement;
  private hudT = 0;
  private last = 0;
  private raf = 0;

  constructor(host: HTMLElement) {
    this.glCanvas = document.createElement('canvas');
    this.glCanvas.id = 'gl';
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.id = 'ov';
    host.append(this.glCanvas, this.overlayCanvas);

    this.scene = new SceneRenderer(this.glCanvas);
    this.overlay = new Overlay(this.overlayCanvas, this.scene);
    this.perf = new PerfMonitor(host, this.scene.gl, this.overlayCanvas);
    this.input = new Input(this.glCanvas, {
      onPress: (code) => onPress(this, code),
      onRepeat: (code) => onRepeat(this, code),
      onWheel: (dy) => onWheel(this, dy),
      onClick: (x, y, locked) => {
        const { W, H } = this.view;
        const hit = pickAt(this, locked ? W / 2 : x, locked ? H / 2 : y);
        // clicking empty space captures the mouse, as before
        if (!hit && !locked) this.input.requestLock();
        this.invalidateHud();
      },
      isActive: () => this.started,
      onPointerLockChange: (locked) => {
        this.pointerLocked = locked;
        this.invalidateHud();
      },
    });
    addEventListener('resize', this.resize);

    this.resize();
    placeAtHome(this);
    this.publishHud();
    this.raf = requestAnimationFrame((t) => {
      this.last = t;
      this.frame(t);
    });
  }

  get keys() {
    return this.input.keys;
  }

  /** Leave the start screen and take control. */
  begin() {
    if (this.started) return;
    this.started = true;
    this.input.requestLock();
    this.pointerLocked = this.input.isLocked();
    this.showMsg('Engines online · hold W to thrust, J for FTL');
    this.publishHud();
  }

  showMsg(text: string, kind: MsgKind = '') {
    this.msg = { text, kind, on: true, t: MSG_TIME };
  }

  /** Publish a HUD snapshot on the next frame instead of waiting for the next tick. */
  invalidateHud() {
    this.hudT = 0;
  }

  loadSystem(sys: StarSystem) {
    const bodies = buildSystem(sys);
    const stations = buildStations(sys, bodies);
    updateBodies(bodies, this.simTime);
    updateStations(stations, this.simTime);
    this.cur = { sys, bodies, star: bodies[0] as CurrentSystem['star'], stations };
    this.frameBody = this.cur.star; // callers place the ship and then pick its frame
    this.nearby = systemsNear(sys.pos, JUMP_RANGE + 1).filter((s) => s.id !== sys.id);
    this.scene.setSystem(this.cur, systemsNear(sys.pos, SKY_RADIUS));
    this.target = null;
    this.refFrame = null;
    this.jumpDest = null;
    this.ship.ap = null;
    this.ship.landed = null;
    closePlanner(this);
  }

  /** Autopilot panel button: first click arms, second disengages (see requestDisengage). */
  requestDisengage() {
    requestDisengage(this);
    this.invalidateHud();
  }

  /** Autopilot panel button: plan a different orbit; the autopilot keeps flying until it's engaged. */
  changeOrbit() {
    if (!this.ship.ap) return;
    this.apPanel = false;
    openPlanner(this);
    this.invalidateHud();
  }

  /** Fast-forward the simulation (for debugging from the console). */
  step(seconds: number, dt = 0.02) {
    for (let t = 0; t < seconds; t += dt) update(this, dt);
    this.publishHud();
  }

  private resize = () => {
    const W = innerWidth,
      H = innerHeight;
    this.view = { W, H, pxPerRad: H / 2 / Math.tan((FOV * Math.PI) / 360) };
    this.scene.resize(W, H);
    this.overlay.resize(W, H);
  };

  private frame = (now: number) => {
    const perf = this.perf;
    perf.frameStart(now - this.last);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.started) update(this, dt);
    else {
      // idle drift behind the start screen
      this.simTime += dt;
      advanceBodies(this);
      this.qInv.copy(this.ship.q).invert();
      this.ship.q.multiply(qa.setFromAxisAngle(AY, -0.012 * dt));
    }
    perf.mark('sim');
    perf.gpuBegin();
    this.scene.render(this);
    perf.gpuEnd();
    perf.mark('render');
    this.overlay.draw(this);
    perf.mark('overlay');
    this.hudT -= dt;
    if (this.hudT <= 0) this.publishHud();
    perf.mark('hud');
    perf.frameEnd();
    this.raf = requestAnimationFrame(this.frame);
  };

  private publishHud() {
    this.hudT = HUD_INTERVAL;
    this.hud.publish(buildSnapshot(this));
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    removeEventListener('resize', this.resize);
    this.input.dispose();
    this.scene.dispose();
    this.perf.dispose();
    this.glCanvas.remove();
    this.overlayCanvas.remove();
  }
}
