import { FOV, HUD_INTERVAL, JUMP_RANGE, MSG_TIME, SHIP, SKY_RADIUS } from './constants';
import { buildSnapshot } from './hud/snapshot';
import { HudStore } from './hud/HudStore';
import { onPress, onRepeat, onWheel } from './input/controls';
import { Input } from './input/Input';
import { THREE } from './lib/three';
import { Overlay } from './render/Overlay';
import { defaultAvionics, type ComputerKind } from './avionics/catalog';
import { PerfMonitor } from './debug/Perf';
import { addNavResult, engageRoute, removeNavPoint, requestCancelRoute, type NavFinal, type NavMode, type Route } from './sim/navroute';
import { SceneRenderer } from './render/SceneRenderer';
import type { Guide } from './sim/guide';
import { pickAt, placeAtHome } from './sim/navigation';
import { closePlanner, openPlanner, requestDisengage } from './sim/planner';
import { update } from './sim/update';
import type { Body, CurrentSystem, Jump, Message, MsgKind, Planner, Power, Ship, StarSystem, Station, Target } from './types';
import { systemsNear } from './universe/galaxy';
import { updateBodies } from './sim/kepler';
import { updateStations } from './sim/stations';
import { buildStations } from './universe/stations';
import { buildSystem } from './universe/system';
import { TEMP, toggleRadiators, type HeatBudget } from './sim/thermal';
import { STOCK_BATTERY, emptyOutfit } from './outfit/catalog';
import { fitBattery, fitModule, removeModule } from './outfit/fit';

function newShip(): Ship {
  return {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(),
    mode: 'normal', throttle: 0, cruise: false, ftlSpooled: false, ftlSpeed: 0, ftlCharge: 0, vmax: 0,
    fa: true, decoupled: false, travelDir: new THREE.Vector3(0, 0, -1), ap: null, landed: null, dead: null, grav: null,
    prop: SHIP.propCap, exotic: SHIP.exoticCap, batt: STOCK_BATTERY.caps.capacity,
    burnRate: 0, sunTrack: false, tanker: null, scoop: '', scoopRate: { prop: 0, exotic: 0 }, avionics: defaultAvionics(), temp: TEMP.start, vent: false, outfit: emptyOutfit(),
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
  readonly power: Power = { solar: 0, cos: 0, shadow: null, draw: 0, net: 0, thrustKW: 0, ftlKW: 0, chargeKW: 0, pumpKW: 0, burn: 0, flux: 0, cap: 0, left: 0, limited: null, curtailed: 0, ftlShort: 0 };
  target: Target | null = null;
  /** Station whose frame flight assist works in, or null for the system frame (see sim/frame.ts). */
  refFrame: Station | null = null;
  /** Body whose frame ship.vel is in: the one whose sphere of influence the ship is in (see sim/frame.ts). */
  frameBody!: Body;
  jumpDest: StarSystem | null = null;
  jump: Jump | null = null;
  planner: Planner | null = null;
  guide: Guide | null = null;
  /** This frame's heat budget (see sim/thermal.ts). */
  heat: HeatBudget | null = null;

  simTime = 0;
  /** Time warp factor (sim/timewarp.ts): 1 = real time. */
  warp = 1;
  curSpeed = 0;
  nearest: Body | null = null;
  nearestAlt = Infinity;
  flash = 0;
  warned: Record<string, boolean> = {};
  msg: Message = { text: '', kind: '', on: false, t: 0 };

  helpVisible = false; // Tab opens the controls (the hint under the system name says so)
  /** Body info panel (I), shown in place of the controls list while open. */
  infoVisible = false;
  /** Avionics panel (U): the fitted computers; shares the left column with info and controls. */
  avionicsVisible = false;
  /** Influences panel (B): gravity, frames, mass lock, light; same column as info and avionics. */
  influencesVisible = false;
  /** Outfit panel (Shift+U, or from the avionics panel): utility slots, and fitting at a station. */
  outfitVisible = false;
  /** Scan progress (0…1) per object key (see sim/scanner.ts), and whether the target is being scanned. */
  /** Navigation computer (M): the panel, its planned or running route, destination star and mode. */
  navPanel = false;
  route: Route | null = null;
  /** Route waypoints (stars), in order; the route passes through each. */
  navPoints: StarSystem[] = [];
  /** Optional final stop after the last waypoint: a body to orbit or a station to meet. */
  navFinal: NavFinal | null = null;
  /** Nav panel star search: the query, and whether results sort by distance from the ship or the last waypoint. */
  navQuery = '';
  navSortFrom: 'ship' | 'last' = 'ship';
  /** Every system in the sky (within SKY_RADIUS), refreshed on arrival: for search, hover and clicks. */
  sky: StarSystem[] = [];
  navMode: NavMode = 'exotic';
  navError: string | null = null;
  navConfirm = 0; // seconds left to confirm cancelling a running route
  readonly scans = new Map<string, number>();
  scanning: Target | null = null;
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
      isActive: () => true,
      onPointerLockChange: (locked) => {
        this.pointerLocked = locked;
        this.invalidateHud();
      },
    });
    addEventListener('resize', this.resize);

    this.resize();
    placeAtHome(this);
    // no title card: you're in the pilot's seat from the first frame (click to capture the mouse)
    this.showMsg('Engines online · hold W to thrust, J for FTL');
    this.publishHud();
    this.raf = requestAnimationFrame((t) => {
      this.last = t;
      this.frame(t);
    });
  }

  get keys() {
    return this.input.keys;
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
    this.sky = systemsNear(sys.pos, SKY_RADIUS);
    this.scene.setSystem(this.cur, this.sky);
    this.target = null;
    this.scanning = null;
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

  /**
   * Avionics table of contents (U): open a computer's tool, as its key would: the orbit planner
   * (or the autopilot's status while it flies), a scan of the target, or the nav panel.
   */
  openAvionics(kind: ComputerKind | 'outfit') {
    if (kind === 'outfit') {
      this.avionicsVisible = false;
      this.outfitVisible = true;
    } else onPress(this, { orbit: 'KeyO', scanner: 'KeyY', nav: 'KeyM' }[kind]);
    this.invalidateHud();
  }

  /** Influences panel: click a body's name to target it. */
  targetByName(name: string) {
    const t = [...this.cur.bodies, ...this.cur.stations].find((x) => x.name === name);
    if (t) {
      this.target = t;
      this.showMsg(`Target · ${t.name}`);
    }
    this.invalidateHud();
  }

  /** Outfit panel buttons (only work alongside a station; see outfit/fit.ts). */
  fitModule(slot: number, id: string) {
    fitModule(this, slot, id);
    this.invalidateHud();
  }

  fitBattery(id: string) {
    fitBattery(this, id);
    this.invalidateHud();
  }

  removeModule(slot: number) {
    removeModule(this, slot);
    this.invalidateHud();
  }

  toggleRadiators() {
    toggleRadiators(this);
    this.invalidateHud();
  }

  togglePump() {
    this.ship.outfit.pumpAuto = !this.ship.outfit.pumpAuto;
    this.invalidateHud();
  }

  /** Nav panel search box and waypoint buttons. */
  setNavQuery(q: string) {
    this.navQuery = q;
    this.invalidateHud();
  }

  setNavSort(from: 'ship' | 'last') {
    this.navSortFrom = from;
    this.invalidateHud();
  }

  addNavResult(key: string) {
    addNavResult(this, key);
    this.invalidateHud();
  }

  removeNavPoint() {
    removeNavPoint(this);
    this.invalidateHud();
  }

  /** Nav panel buttons. */
  engageRoute() {
    engageRoute(this);
    this.invalidateHud();
  }

  cancelRoute() {
    requestCancelRoute(this);
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
    update(this, dt * this.warp, dt);
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
