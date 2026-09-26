import type { THREE } from './lib/three';

type Vec3 = THREE.Vector3;
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

interface BodyBase {
  name: string;
  typeName: string;
  radius: number; // m
  pos: Vec3; // m, system frame (bodies are fixed in space)
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
  orbit: number; // m
  T: number; // equilibrium temperature, K
  tilt: number;
  ring?: Ring;
}

export type Body = Star | World;

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
}

export interface Gravity {
  body: Body;
  vec: Vec3; // acceleration, m/s²
  g: number; // magnitude, m/s²
  r: number; // distance to the body's centre, m
}

export type OrbitType = 'equatorial' | 'polar' | 'sync' | 'hold';

export interface Autopilot {
  body: Body;
  type: OrbitType;
  r0: number; // target orbit radius, m
  period: number;
  n: Vec3 | null; // orbit normal (null when holding position)
  point: Vec3 | null; // hold point (only when holding position)
  phase: 'charge' | 'transfer' | 'insert';
  settled: boolean;
}

export interface Tanker {
  t: number;
  docked?: boolean;
}

export interface Ship {
  pos: Vec3;
  vel: Vec3;
  q: THREE.Quaternion;
  mode: 'normal' | 'ftl';
  throttle: number;
  ftlSpeed: number;
  ftlCharge: number;
  vmax: number;
  fa: boolean; // flight assist
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
}

/** Per-frame power bookkeeping. */
export interface Power {
  solar: number;
  cos: number;
  shadow: Body | null;
  draw: number;
  net: number;
  thrustKW: number;
  ftlKW: number;
  chargeKW: number;
  burn: number;
  flux: number;
}

export interface Jump {
  phase: 'charge' | 'tunnel';
  t: number;
  dest: StarSystem;
  loaded: boolean;
  cost: number;
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
