import type { MsgKind, OrbitType } from '../types';

/** A text readout, optionally flagged as a warning. */
export interface Readout {
  text: string;
  warn?: boolean;
}

export interface Gauge {
  frac: number; // 0..1
}

export interface NavigationView {
  clock: string;
  system: string;
  star: string;
  galactic: string;
  x: string;
  y: string;
  z: string;
}

export interface FlightView {
  mode: string;
  modeClass: '' | 'ftl' | 'warn';
  speed: string;
  unit: string;
  barFrac: number;
  barFtl: boolean;
  barLabel: string;
  barValue: string;
  flightAssist: Readout;
  gravity: Readout;
}

export interface TargetView {
  type: string;
  body: string;
  distance: string;
  eta: string;
  nearest: Readout;
  vertical: Readout;
  orbit: Readout;
  jump: string;
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

export interface SystemsView {
  mass: string;
  prop: string;
  propFrac: number;
  deltaV: string;
  flow: Readout;
  exotic: string;
  exoticFrac: number;
  jumps: string;
  exoticRate: string;
  batt: string;
  battFrac: number;
  net: Readout;
  battTime: string;
  solar: Readout;
  load: string;
  note: string;
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
  nav: NavigationView;
  flight: FlightView;
  target: TargetView;
  systems: SystemsView;
  planner: PlannerView | null;
  guide: GuideView | null;
}
