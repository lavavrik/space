import { spawnTraffic, type Npc } from './sim/traffic';
import { noAero, type AeroState } from './sim/atmosphere';
import { FOV, HUD_INTERVAL, JUMP_RANGE, MSG_TIME, SHIP, SKY_RADIUS } from './constants';
import { buildSnapshot } from './hud/snapshot';
import { HudStore } from './hud/HudStore';
import { onPress, onRepeat, onWheel } from './input/controls';
import { Input } from './input/Input';
import { THREE } from './lib/three';
import { fmtDist } from './format';
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
import { BATTERIES, bestOutfit } from './outfit/catalog';
import { ZOOM_START, updatePeriscope } from './sim/periscope';
import { startPivot } from './sim/pivot';
import { contactLabel, radarContacts, radarSweep } from './sim/radar';
import { toggleScan } from './sim/scanner';
import { dockKey, launch, type Dock } from './sim/docking';
import { catapultLaunch, type Ascent } from './sim/catapult';
import type { RockThreat } from './sim/belt';
import { laserOff, type LaserState } from './sim/laser';
import { START_CREDITS, buyFuel, buyRepair, sellCargo } from './sim/economy';
import type { AutoPhase } from './sim/autodock';
import { fitBattery, fitModule, removeModule } from './outfit/fit';
import { AUTOSAVE_S, clearSave, loadGame, saveGame } from './save';
import { toggleLoad, type Switchable } from './sim/power';

/** A ship with full tanks and the best gear (yours, and every other ship's: sim/traffic.ts). */
export function newShip(): Ship {
  return {
    pos: new THREE.Vector3(), vel: new THREE.Vector3(), q: new THREE.Quaternion(),
    mode: 'normal', throttle: 0, cruise: false, ftlSpeed: 0, ftlCharge: 0, vmax: 0,
    fa: true, decoupled: false, travelDir: new THREE.Vector3(0, 0, -1), ap: null, landed: null, dead: null, grav: null,
    hull: 1, cargo: {}, prop: SHIP.propCap, exotic: SHIP.exoticCap, batt: BATTERIES[BATTERIES.length - 1].caps.capacity,
    burnRate: 0, sunTrack: false, tanker: null, scoop: '', scoopRate: { prop: 0, exotic: 0 }, avionics: defaultAvionics(), temp: TEMP.start, vent: false, outfit: bestOutfit(),
    breakers: { thrust: true, ftl: true, charge: true, radar: true, shield: true, guard: true },
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
  readonly power: Power = { solar: 0, shore: 0, cos: 0, shadow: null, draw: 0, net: 0, thrustKW: 0, ftlKW: 0, chargeKW: 0, pumpKW: 0, radarKW: 0, lightsKW: 0, shieldKW: 0, guardKW: 0, laserKW: 0, burn: 0, flux: 0, cap: 0, left: 0, limited: null, curtailed: 0, ftlShort: 0 };
  /**
   * One selection at a time: a body or station (target) or a star to jump to (jumpDest). Setting
   * either clears the other. A hyperjump in progress keeps its own destination (jump.dest).
   */
  private _target: Target | null = null;
  private _jumpDest: StarSystem | null = null;
  get target() {
    return this._target;
  }
  set target(t: Target | null) {
    this._target = t;
    if (t) this._jumpDest = null;
  }
  get jumpDest() {
    return this._jumpDest;
  }
  set jumpDest(s: StarSystem | null) {
    this._jumpDest = s;
    if (s) {
      this._target = null;
      this.scanning = null; // the scanner works on the target
    }
  }
  /** Station whose frame flight assist works in, or null for the system frame (see sim/frame.ts). */
  refFrame: Station | null = null;
  /** Body whose frame ship.vel is in: the one whose sphere of influence the ship is in (see sim/frame.ts). */
  frameBody!: Body;
  jump: Jump | null = null;
  planner: Planner | null = null;
  guide: Guide | null = null;
  /** This frame's heat budget (see sim/thermal.ts). */
  heat: HeatBudget | null = null;
  /** Other ships in the system (sim/traffic.ts). */
  traffic: Npc[] = [];
  /** The air around the ship this frame: drag and entry heating (sim/atmosphere.ts). */
  aero: AeroState = noAero();

  simTime = 0;
  /** Time warp factor (sim/timewarp.ts): 1 = real time. */
  warp = 1;
  /** Docking (sim/docking.ts): the granted pad, and whether we're on it. */
  dock: Dock | null = null;
  /** A docking request waiting for traffic control's answer (s left). */
  dockRequest: { station: Station; t: number } | null = null;
  /** The station whose hull the ship is inside this frame (slot, tunnel or hangar), if any. */
  inStation: Station | null = null;
  /** The ship's offset from that station's centre at the end of the last step (m). */
  inStationRel = new THREE.Vector3();
  /** Docking computer (sim/autodock.ts): its phase, the station and pad it's working with, and the
   *  ship's offset from that station at the end of the last step. */
  autodock: { phase: AutoPhase } | null = null;
  autodockStation: Station | null = null;
  autodockPad = 0;
  /** The ascent program after a sky station's catapult (sim/catapult.ts), while it flies. */
  ascent: Ascent | null = null;
  /** In a ring's belt (sim/belt.ts): hull wear from its dust (per s), the rock on a collision course, and whether the radar is nudging you clear this step. */
  erosion = 0;
  rockThreat: RockThreat | null = null;
  nudging = false;
  /** The mining laser (sim/laser.ts): on or off, and what its beam is doing. */
  laser: LaserState = laserOff();
  dockRel = new THREE.Vector3();
  /** Radar (sim/radar.ts): seconds left of the sweep in progress (0 = idle), and every object it
   *  has found (scan keys, so per system). */
  radar: { sweep: number; seen: Set<string> } = { sweep: 0, seen: new Set() };
  /** Headlights (Shift+L): a floodlight cone along the nose (render/shaders/headlight.glsl). */
  lights = true;
  /** Radar window (Shift+Y), in the left column. */
  radarVisible = false;
  /** Turning to face the target (middle mouse button; sim/pivot.ts). */
  pivot = false;
  /** The pivot's turn rate (rad/s): it spins up and brakes (sim/pivot.ts). */
  pivotRate = 0;
  /** The pivot reached its target and is holding the nose on it (sim/pivot.ts). */
  pivotLocked = false;
  /** While locked, the turn rate (rad/s, world axes) following the target takes (sim/pivot.ts). */
  lockOmega = new THREE.Vector3();
  /** The pivot's aim direction last frame (to follow a moving target's own motion). */
  pivotPrevDir: THREE.Vector3 | null = null;
  /** The ship's turn rate under manual steering (rad/s: pitch, yaw, roll about its own axes; sim/update.ts). */
  angVel = new THREE.Vector3();
  /**
   * Manual steering's reference "up" (sim/update.ts): mouse and arrow turns keep the ship's roll
   * against it, only Q/E change it; null until steering first uses it.
   */
  steerUp: THREE.Vector3 | null = null;
  /** The orientation manual steering last left the ship in (anything else turning it re-seeds steerUp). */
  steerQ = new THREE.Quaternion();
  /** Periscope (sim/periscope.ts): up or not, the magnification set, and the current (eased) one. */
  zoom = { on: false, mag: ZOOM_START, cur: 1 };
  /** Vertical field of view (degrees) right now: FOV narrowed by the periscope. */
  fov = FOV;
  curSpeed = 0;
  nearest: Body | null = null;
  nearestAlt = Infinity;
  flash = 0;
  warned: Record<string, boolean> = {};
  msg: Message = { text: '', kind: '', on: false, t: 0 };

  /** Names on the HUD's markers (bodies, stations, ships, stars); Shift+N turns them off for a clean view. */
  showNames = true;
  /** Your credits (sim/economy.ts): yours, not the ship's, so a replacement keeps them. */
  credits = START_CREDITS;
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
  /** When the game was last saved (wall clock, ms; 0 = not yet), and seconds to the next autosave (save.ts). */
  savedAt = 0;
  private saveT = AUTOSAVE_S;
  /** Starting over: nothing more is saved before the reload. */
  private noSave = false;
  /** Seconds left to confirm starting a new game (0 = not armed). */
  newGameConfirm = 0;

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
      onMiddleClick: () => {
        startPivot(this);
        this.invalidateHud();
      },
      onPointerLockChange: (locked) => {
        this.pointerLocked = locked;
        this.invalidateHud();
      },
    });
    addEventListener('resize', this.resize);

    this.resize();
    // resume the saved game if there is one (save.ts), otherwise start at home
    if (!loadGame(this)) {
      placeAtHome(this);
      // no title card: you're in the pilot's seat from the first frame (click to capture the mouse)
      this.showMsg('Engines online · hold W to thrust, J for FTL');
    }
    // save when the page is hidden or closed (tab switch, reload, quit), besides the autosave
    addEventListener('pagehide', this.saveNow);
    document.addEventListener('visibilitychange', this.onVisibility);
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
    this.dock = null;
    this.dockRequest = null;
    this.inStation = null;
    this.autodock = null;
    this.autodockStation = null;
    this.ascent = null;
    this.nearby = systemsNear(sys.pos, JUMP_RANGE + 1).filter((s) => s.id !== sys.id);
    this.sky = systemsNear(sys.pos, SKY_RADIUS);
    this.scene.setSystem(this.cur, this.sky);
    this.traffic = spawnTraffic(this); // after the system's state is reset: each ship copies it
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
    } else if (kind === 'dock') {
      // the docking tile: dock (or launch), never K's other job of calling a tanker
      if (!dockKey(this)) {
        const unit = this.ship.avionics.dock;
        this.showMsg(`Target a station to dock at (within ${unit?.caps.clearance ? fmtDist(unit.caps.range) : '10 km'})`, 'warn');
      }
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

  /** Docked panel buttons. */
  refuelDocked() {
    buyFuel(this);
    this.invalidateHud();
  }

  repairDocked() {
    buyRepair(this);
    this.invalidateHud();
  }

  sellCargo() {
    sellCargo(this);
    this.invalidateHud();
  }

  launch() {
    launch(this);
    this.invalidateHud();
  }

  /** Docked at a sky station: the catapult (sim/catapult.ts). */
  catapult() {
    catapultLaunch(this);
    this.invalidateHud();
  }

  /** Radar window buttons. */
  radarSweep() {
    radarSweep(this);
    this.invalidateHud();
  }

  /** Radar row: target this contact, and with `scan` start the scanner on it. */
  radarPick(key: string, scan: boolean) {
    const c = radarContacts(this).find((x) => x.key === key);
    if (!c) return;
    this.target = c.target;
    if (scan) toggleScan(this);
    else this.showMsg(`Target · ${contactLabel(this, c.target)}`);
    this.invalidateHud();
  }

  /** Outfit panel's back button: return to ship stats (U). */
  openShipStats() {
    this.outfitVisible = false;
    this.avionicsVisible = true;
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

  /** Top-right button with the mouse free: capture it for steering. */
  captureMouse() {
    this.input.requestLock();
  }

  /** Power schematic switches (ship stats, U). */
  toggleLoad(id: Switchable) {
    toggleLoad(this, id);
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

  /** Save now (also the autosave, and on leaving the page). */
  saveNow = () => {
    if (!this.noSave) saveGame(this);
  };

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.saveNow();
  };

  /** Controls panel button: first click arms, a second within a few seconds wipes the save and starts over. */
  newGame() {
    if (this.newGameConfirm <= 0) {
      this.newGameConfirm = 4;
      this.showMsg('Start a new game? Click again to confirm · your save will be deleted', 'warn');
      this.invalidateHud();
      return;
    }
    this.noSave = true;
    clearSave();
    location.reload();
  }

  /** Fast-forward the simulation (for debugging from the console). */
  step(seconds: number, dt = 0.02) {
    for (let t = 0; t < seconds; t += dt) update(this, dt);
    this.publishHud();
  }

  private resize = () => {
    const W = innerWidth,
      H = innerHeight;
    this.view = { W, H, pxPerRad: H / 2 / Math.tan((this.fov * Math.PI) / 360) };
    this.scene.resize(W, H);
    this.overlay.resize(W, H);
  };

  private frame = (now: number) => {
    const perf = this.perf;
    perf.frameStart(now - this.last);
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    updatePeriscope(this, dt);
    update(this, dt * this.warp, dt);
    if ((this.saveT -= dt) <= 0) {
      this.saveT = AUTOSAVE_S;
      this.saveNow();
    }
    if (this.newGameConfirm > 0 && (this.newGameConfirm -= dt) <= 0) {
      this.newGameConfirm = 0;
      this.invalidateHud();
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
    removeEventListener('pagehide', this.saveNow);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.input.dispose();
    this.scene.dispose();
    this.perf.dispose();
    this.glCanvas.remove();
    this.overlayCanvas.remove();
  }
}
