import type { ComputerKind } from '../avionics/catalog';
import type { MsgKind, OrbitType } from '../types';

/** A text readout, optionally flagged as a warning. */
export interface Readout {
  text: string;
  warn?: boolean;
}

/** Top-left: where you are, and where the hyperdrive is set to take you. */
export interface LocationView {
  system: string;
  star: string; // spectral class, radius, temperature
  sub: string; // galactic position · sim clock
  jump: Readout; // jump destination, or a hint
}

/** A status chip under the speed readout (flight assist, decoupled, cruise, gravity). */
export interface Pill {
  text: string;
  kind: '' | 'on' | 'ftl' | 'warn';
}

/** Bottom centre: the speedo cluster. */
export interface FlightView {
  mode: string;
  modeClass: '' | 'ftl' | 'warn';
  speed: string;
  unit: string;
  barFrac: number;
  barFtl: boolean;
  barLabel: string;
  barValue: string;
  /** Normal space: where the normal speed limit sits on the bar (0..1; the bar runs to the boost limit). */
  barMark?: number;
  /** Which caption end is the limit flight assist is holding you to right now. */
  barHi?: 'left' | 'right';
  alt: Readout | null; // altitude and vertical speed near a body
  orbit: Readout | null; // orbit status around the body pulling on you
  pills: Pill[];
}

/** Bottom right: the current target, or a hint when there's none. */
export interface TargetView {
  name: string;
  type: string;
  distance: string;
  eta: string;
  none: boolean;
  scan: Readout | null; // scan status (unscanned / scanning / out of resolution); null once scanned
  scanFrac: number; // 0…1, for the card's scan bar
}

/** One ship gauge: label, value, fill, and a one-line detail. */
export interface GaugeView {
  label: string;
  value: string;
  frac: number;
  variant?: 'ftl' | 'batt' | 'heat';
  sub: Readout;
}

/** Body info panel (I): the target's physical data, its own orbit, and the ship relative to it. */
export interface InfoView {
  title: string;
  type: string;
  physical: [string, string][];
  orbitHead: string; // e.g. "ORBITS VENYDES" or "ANCHORS THE SYSTEM"
  orbit: [string, string][];
  you: [string, string | Readout][];
}

/** Bottom left: propellant, exotic matter, battery, and a note when something needs attention. */
export interface SystemsView {
  gauges: GaugeView[];
  note: Readout | null;
}

/** Autopilot status (O while it flies): what it's flying, how far off you are, and disengage. */
export interface AutopilotView {
  unit: string; // the orbit computer flying it
  title: string; // e.g. EQUATORIAL ORBIT
  sub: string; // body · target altitude · period
  state: Readout;
  rows: [string, string | Readout][];
  confirm: boolean; // disengage armed, waiting for the second press
}

/** Influences panel (B): what's acting on the ship (see hud/influences.ts). */
export interface InfluencesView {
  gravity: { name: string; value: string; detail: string; frac: number; applied: boolean }[];
  frame: [string, string | Readout][];
  ftl: [string, string | Readout][];
  light: [string, string | Readout][];
  heat: [string, string | Readout][];
}

/** One fitted computer in the avionics panel (U). */
export interface AvionicsSlotView {
  id: ComputerKind; // what opening this entry does (see Game.openAvionics)
  key: string; // the key that opens it
  does: string; // what it's for, in a few words
  status: Readout; // what it's doing right now
  active: boolean; // busy (flying, scanning, routing)
  kind: string; // ORBIT COMPUTER, SCANNER, NAVIGATION
  unit: string; // HX-9100 Periastron, or 'none fitted'
  maker: string;
  blurb: string;
  specs: [string, string][];
}

/** Navigation computer panel (M): the route to the destination, planned or being flown. */
export interface NavView {
  unit: string;
  dest: string;
  modes: { label: string; on: boolean }[] | null; // null: the unit has one fixed mode
  legs: { text: string; detail: string; state: 'done' | 'active' | 'pending' }[];
  totals: string;
  warning: Readout | null;
  running: boolean;
  status: string;
  confirm: boolean;
  hint: string;
  points: string[]; // waypoints, in order
  query: string;
  sortFrom: 'ship' | 'last';
  results: { key: string; kind: 'star' | 'planet' | 'moon' | 'station'; name: string; detail: string }[];
}

export interface PlannerView {
  unit: string; // the orbit computer planning it, e.g. HX-9100 PERIASTRON
  types: OrbitType[]; // the orbit types that unit can fly
  body: string;
  type: OrbitType;
  alt: string;
  period: string;
  speed: string;
  dir: string;
  note: Readout;
}

export interface GuideStepView {
  num: number;
  className: string;
  badge: string;
  title: string;
  eta: string;
  detail: string;
  prog: number;
  extra: string;
}

export interface GuideView {
  title: string;
  sub: string;
  eta: string;
  steps: GuideStepView[];
  end: Readout | null;
  foot: string;
  time: string;
}

export interface HudSnapshot {
  helpVisible: boolean;
  info: InfoView | null;
  showRelock: boolean;
  toast: { text: string; kind: MsgKind; visible: boolean };
  location: LocationView;
  flight: FlightView;
  target: TargetView;
  systems: SystemsView;
  planner: PlannerView | null;
  autopilot: AutopilotView | null;
  avionics: AvionicsSlotView[] | null; // the avionics panel, when open
  influences: InfluencesView | null;
  nav: NavView | null;
  guide: GuideView | null;
}
