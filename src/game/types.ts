import type { Avionics } from './avionics/catalog';
import type { Outfit } from './outfit/catalog';
import type { THREE } from './lib/three';

type Vec3 = THREE.Vector3;
type Quat = THREE.Quaternion;
type Color = THREE.Color;

/** Surface / composition type of a planet or moon (see WT in constants). Indexes TYPES, DENSITY and ALBEDO. */
export type WorldType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Palette {
  a: Color;
  b: Color;
  c: Color;
  d: Color;
  sea: number;
  atmo: { c: Color; k: number } | null;
}

export interface Ring {
  inner: number; // in planet radii
  outer: number;
  color: Color;
  seed: number;
}

/**
 * A Kepler orbit around a parent, fixed by its elements. Position at any time comes from
 * `keplerState` (sim/kepler.ts), so orbits are exact and need no integration.
 */
export interface KeplerOrbit {
  a: number; // semi-major axis, m
  e: number; // eccentricity
  P: Vec3; // unit vector toward periapsis
  Q: Vec3; // unit vector 90° ahead in the direction of motion
  n: number; // mean motion, rad/s
  M0: number; // mean anomaly at simTime 0, rad
}

interface BodyBase {
  name: string;
  typeName: string;
  radius: number; // m
  pos: Vec3; // m, system frame (the star sits at the origin; worlds move on their orbits)
  vel: Vec3; // m/s, system frame
  seed: number;
  mass: number; // kg
  mu: number; // G·M
  soi: number; // sphere of influence radius, m
  spin: number; // rad/s
  axis: Vec3; // spin axis, world space
  rot: number; // current rotation about the spin axis, rad
}

export interface Star extends BodyBase {
  kind: 'star';
  color: Color;
  L: number; // luminosity, solar units
}

export interface World extends BodyBase {
  kind: 'planet' | 'moon';
  type: WorldType;
  pal: Palette;
  albedo: number;
  parent: Body;
  orbit: number; // m, distance from the parent when generated (≈ semi-major axis)
  orb: KeplerOrbit;
  T: number; // equilibrium temperature, K
  tilt: number;
  ring?: Ring;
}

export type Body = Star | World;

/**
 * A station. Not a Body: it has no gravity, doesn't mass-lock, and isn't in
 * `CurrentSystem.bodies`. `pos` and `vel` are recomputed from the sim clock every step (see
 * sim/stations.ts):
 *   - an orbital station (a Coriolis cube) follows a fixed Kepler orbit around its parent;
 *   - a sky station (`sky` set) hangs 10–20 km over one spot on its world's surface, turning with
 *     the world. It's an open deck with its pads on top (sim/skyGeom.ts). Its Kepler fields are
 *     placeholders (a = its distance from the centre, n = the world's spin) so code that reads an
 *     orbit still gets sane numbers.
 */
export interface Station extends KeplerOrbit {
  kind: 'station';
  name: string;
  typeName: string;
  parent: World;
  size: number; // m, edge of the cube
  radius: number; // m, half the cube's diagonal (for targeting and markers)
  seed: number;
  spinAxis: Vec3;
  spinRate: number; // rad/s about spinAxis, which runs through the docking slot (sim/stationGeom.ts); a sky station: its world's axis and spin
  pos: Vec3; // m, system frame
  vel: Vec3; // m/s, system frame
  sky?: SkyAnchor;
}

/** Where a sky station hangs: fixed in its world's own (turning) frame. */
export interface SkyAnchor {
  dir: Vec3; // unit direction from the world's centre, in the world's frame (worldQuat)
  r: number; // m from the world's centre
  alt: number; // m above the ground under it
}

/** Anything the ship can target. */
export type Target = Body | Station | Npc;

/** Another ship (sim/traffic.ts): a target like a body or a station, but tiny and without gravity. */
export interface Npc {
  kind: 'ship';
  radius: number; // m, for the radar, scanner and clicks
  name: string;
  cls: string; // "Freighter", "Courier", …
  /** Its ship's position (the same vector), velocity in the system frame, and attitude (the same
   * quaternion; nose along −z like yours). Flown by sim/traffic.ts on the player's flight code. */
  pos: Vec3;
  vel: Vec3;
  q: Quat;
  /** In FTL, and its thrust this step: +1 along the nose (main engine), −1 against it, 0 coasting. */
  ftl: boolean;
  thrust: number;
  /** What its captain is doing (sim/traffic.ts), where it is or last was, and where it's going. */
  task: 'docked' | 'launch' | 'travel' | 'dock' | 'orbit';
  at: Body | Station | null;
  to: Body | Station | null;
  /** Seconds into the task, and how long it stays (docked or in orbit) before moving on. */
  t: number;
  wait: number;
  /** The trail streaming behind it: length (m) and direction (world, unit). */
  trailL: number;
  trailDir: Vec3;
  /** Sim time of its last FTL entry or exit (the flash), or −∞. */
  flashAt: number;
}


export interface StarInfo {
  cls: string;
  spec: string;
  T: number;
  R: number; // solar radii
  L: number; // solar luminosities
  color: Color;
}

export interface StarSystem {
  id: string; // stable across sessions: "ix,iy,iz:k" (sector coordinates and index within it)
  seed: number;
  pos: Vec3; // ly, galactic frame
  name: string;
  star: StarInfo;
}

/** The system the ship is currently in. */
export interface CurrentSystem {
  sys: StarSystem;
  bodies: Body[];
  star: Star;
  stations: Station[];
}

export interface Gravity {
  body: Body;
  vec: Vec3; // acceleration, m/s²
  g: number; // magnitude, m/s²
  r: number; // distance to the body's centre, m
}

/** 'ring': a circular orbit in a ring's plane, moving with its rocks (sim/rings.ts). */
export type OrbitType = 'equatorial' | 'polar' | 'sync' | 'hold' | 'ring';
/** What the autopilot can fly: an orbit type, or a rendezvous with a station (set by the nav computer). */
export type ApType = OrbitType | 'rendezvous';

export interface Autopilot {
  body: Body;
  type: ApType;
  station: Station | null; // rendezvous only: the station to close on and match
  r0: number; // target orbit radius, m
  period: number;
  n: Vec3 | null; // orbit normal (null when holding position)
  point: Vec3 | null; // hold point, as an offset from the body (only when holding position)
  phase: 'charge' | 'transfer' | 'insert';
  settled: boolean;
  t0: number; // sim time when engaged
  prop0: number; // propellant (kg) when engaged, for the Δv-used readout
}

export interface Tanker {
  t: number;
  docked?: boolean;
}

export interface Ship {
  pos: Vec3;
  vel: Vec3; // m/s, relative to Game.frameBody (patched conics; see sim/frame.ts)
  q: THREE.Quaternion;
  mode: 'normal' | 'ftl';
  throttle: number;
  /** FTL cruise control (F): the throttle holds. Off, it spools down unless you hold W. */
  cruise: boolean;
  ftlSpeed: number;
  ftlCharge: number;
  vmax: number;
  fa: boolean; // flight assist
  /** Decoupled (V): turning doesn't change where you're going, in normal space or FTL. */
  decoupled: boolean;
  /** Unit vector the FTL drive pushes along: the nose, or wherever it pointed when decoupled. */
  travelDir: Vec3;
  ap: Autopilot | null; // orbit autopilot
  landed: Body | null; // body we are resting on
  dead: { t: number; reason: string; body: Body } | null;
  grav: Gravity | null;
  prop: number; // kg of hydrogen
  exotic: number; // kg of exotic matter
  batt: number; // kWh
  burnRate: number; // kg/s of propellant, smoothed for display
  sunTrack: boolean; // keep the solar panels (ship's top) facing the star
  tanker: Tanker | null;
  scoop: string; // what we are refuelling from this frame
  scoopRate: { prop: number; exotic: number }; // kg/s being scooped this frame
  avionics: Avionics; // fitted computers (see avionics/catalog.ts)
  temp: number; // K, hull temperature (see sim/thermal.ts)
  hull: number; // structural integrity, 0–1 (0: lost; sim/damage.ts)
  vent: boolean; // venting hydrogen to cool the hull (R)
  outfit: Outfit; // modules in the utility slots (see outfit/catalog.ts)
  /** Power switches for loads that have no switch of their own (sim/power.ts; headlights and the heat pump do). */
  breakers: Record<Breaker, boolean>;
}

/** Loads on the power bus that can be switched off in the schematic (sim/power.ts). */
export type Breaker = 'thrust' | 'ftl' | 'charge' | 'radar';

/** Per-frame power bookkeeping. */
export interface Power {
  solar: number;
  shore: number; // kW of external (station) power while docked
  cos: number;
  shadow: Body | null;
  draw: number;
  net: number;
  thrustKW: number;
  ftlKW: number;
  chargeKW: number;
  pumpKW: number; // heat pump (set by sim/thermal.ts for the next frame)
  radarKW: number; // radar, while it's on (sim/radar.ts)
  lightsKW: number; // headlights, while they're on
  burn: number;
  cap: number; // kW the bus can supply this frame: solar + the battery's discharge limit (sim/power.ts)
  left: number; // kW not yet granted this frame
  limited: { what: string; frac: number } | null; // the first load that got less than it asked for
  curtailed: number; // kW of solar the battery couldn't take
  ftlShort: number; // s the FTL drive has been short of power (it fails past a brief brownout)
  flux: number;
}

export interface Jump {
  /** charge the drive, then depart (accelerate out through the system), then the tunnel (hyperspace) */
  phase: 'charge' | 'depart' | 'tunnel';
  t: number;
  dest: StarSystem;
  cost: number;
  from: Vec3; // ly, galactic: where the transit starts
  dur: number; // s, length of the tunnel phase
}

export interface Planner {
  body: Body;
  type: OrbitType;
  alt: number;
  dir: number; // +1 prograde, −1 retrograde
  curAlt: number;
}

export type MsgKind = '' | 'ftl' | 'warn';

export interface Message {
  text: string;
  kind: MsgKind;
  on: boolean;
  t: number;
}
