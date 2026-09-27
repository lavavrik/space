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
}

/** One ship gauge: label, value, fill, and a one-line detail. */
export interface GaugeView {
  label: string;
  value: string;
  frac: number;
  variant?: 'ftl' | 'batt';
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
  title: string; // e.g. EQUATORIAL ORBIT
  sub: string; // body · target altitude · period
  state: Readout;
  rows: [string, string | Readout][];
  confirm: boolean; // disengage armed, waiting for the second press
}

export interface PlannerView {
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
  started: boolean;
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
  guide: GuideView | null;
}
