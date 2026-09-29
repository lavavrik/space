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
  approach: ApproachView | null;
}

/** A milestone on the approach strip (hud/approach.ts): x ∈ [0, 1] from the left, label row 0/1 or −1 (tick only). */
export interface ApproachMark {
  d: number;
  label: string;
  detail: string;
  kind: 'info' | 'on' | 'ftl' | 'warn';
  x: number;
  row: number;
  outside: boolean; // beyond the window, squeezed into the left zone
}
export interface ApproachView {
  shipX: number;
  /** Getting farther from the target: the ship marker points away (left). */
  away: boolean;
  marks: ApproachMark[];
  scale: string; // the window's far edge
}

export interface GaugeBadge {
  icon: 'panels-off' | 'vent' | 'radiators' | 'pump';
  title: string;
  warn?: boolean;
}

/** One ship gauge: label, value, fill, and a one-line detail. */
export interface GaugeView {
  label: string;
  /** An icon before the label (ui/components/icons.ts RESOURCE_ICONS). */
  icon?: 'prop' | 'exotic' | 'cargo' | 'o2';
  value: string;
  frac: number;
  variant?: 'ftl' | 'batt' | 'heat' | 'o2';
  sub: Readout;
  /** Status icons beside the label, e.g. the solar panels feathered by heat, the hydrogen vent running. */
  badges?: GaugeBadge[];
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

/** Icon per kind of module (see ui/components/icons.ts). */
export type ModuleIcon = 'battery' | 'scoop' | 'radiator' | 'heatpump' | 'deflector' | 'guard' | 'laser' | 'fuelcell' | 'empty';

/** One fitted computer in the avionics panel (U). */
export interface AvionicsSlotView {
  id: ComputerKind | 'outfit'; // what opening this entry does (see Game.openAvionics)
  key: string; // the key that opens it
  does: string; // what it's for, in a few words
  status: Readout; // what it's doing right now
  active: boolean; // busy (flying, scanning, routing)
  kind: string; // ORBIT COMPUTER, SCANNER, NAVIGATION
  unit: string; // HX-9100 Periastron, or 'none fitted'
  model: string; // HX-9100 (the tile's short label)
  /** Outfit tile: the battery and each fitted module, as icons. */
  mods?: { icon: ModuleIcon; title: string }[];
  maker: string;
  blurb: string;
  specs: [string, string][];
}

/** Ship stats (U), electrical section: drawn as a schematic (sources → bus → loads), plus a few rows. */
import type { Switchable } from '../sim/power';
export interface ElectricalView {
  solar: { kw: number; max: number; state: 'ok' | 'shadow' | 'feathered' | 'dark' | 'inside'; curtailed: number };
  /** External power: the station's supply while docked (null source name when not connected). */
  shore: { kw: number; source: string | null };
  battery: { unit: string; kwh: number; cap: number; flowKW: number; maxKW: number; chargeKW: number };
  /** The fuel cell, if fitted (sim/oxygen.ts): output now, its rating, switched on, running, and what it burns (kg/h). */
  fuelcell: { unit: string; kw: number; max: number; on: boolean; running: boolean; h2: number; o2: number } | null;
  bus: { capKW: number; drawKW: number };
  /** `sw`: the load's power switch (sim/power.ts), and whether it's on; null for loads that can't be switched. */
  loads: { id: string; name: string; kw: number; limited: number | null; sw: Switchable | null; on: boolean }[];
  rows: [string, string | Readout][];
}

/** Radar window (Shift+Y): the scope and the contact list. */
export interface RadarView {
  sweeping: number; // 0…1 progress of the sweep in progress, or 0
  range: string;
  power: string;
  /** Scope rings: radius (0…1 of the scope) and label. */
  rings: { r: number; label: string }[];
  contacts: {
    key: string;
    label: string;
    cls: string;
    dist: string;
    x: number; // scope position, −1…1, nose up
    y: number;
    above: boolean; // above or below the ship's wings
    scanned: boolean;
    scanning: boolean;
    targeted: boolean;
  }[];
  /** In a belt, the sweep's metal-rich finds (sim/prospect.ts), best first: numbered as on the view. */
  prospects: { n: number; kind: 'icy' | 'nickel-iron' | 'cobalt-rich' | 'platinum-rich'; size: string; dist: string; worth: string }[];
}

/** Outfit panel (Shift+U): the utility slots, the thermal hardware's state, and fitting at a station. */
export interface OutfitView {
  station: string | null; // the station that can fit modules right now
  battery: { id: string; unit: string; maker: string; blurb: string; specs: string; options: OutfitCard[] };
  hint: string; // how to get to one, when not alongside
  slots: { id: string | null; unit: string; maker: string; blurb: string; specs: string; empty: boolean; icon: ModuleIcon }[];
  /** What the station fits (empty when not alongside one): every module, grouped by `kind` in the panel. */
  catalogue: OutfitCard[];
  radiators: { fitted: boolean; out: number; deploying: boolean; status: string };
  pump: { fitted: boolean; auto: boolean; status: string };
  mass: string;
}

/** A module or battery on offer, as a card: what it is, what it does, and its price here. */
export interface OutfitCard {
  id: string;
  unit: string; // "FC-150 Hearth"
  kind: string; // "FUEL CELL"
  icon: ModuleIcon;
  maker: string;
  blurb: string;
  specs: string;
  price: string;
  current: boolean; // (batteries: the fitted one)
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

/**
 * Dashboard tell-tales above the speedometer (render: ui/components/Hud.tsx, Lamps): one icon per
 * system, dim when off and lit when on, like an old car's dashboard. `state` picks the colour:
 * amber for on, cyan for drive/FTL-related, red for a warning; `blink` while something is changing.
 */
export type LampId =
  | 'fa' | 'decoupled' | 'autopilot' | 'cruise' | 'dock'
  | 'sun' | 'lights' | 'radiators' | 'pump' | 'vent' | 'scoop' | 'radar' | 'shore' | 'fuelcell'
  | 'charge' | 'entry' | 'masslock' | 'hot' | 'battery' | 'power' | 'warp' | 'pivot' | 'zoom';
export interface Lamp {
  id: LampId;
  /** Tooltip: what it is, the key that toggles it (if any), and a line of live detail. */
  name: string;
  key?: string;
  detail?: string;
  state: 'off' | 'on' | 'ftl' | 'warn';
  blink?: boolean;
  /** 0…1: a ring round the icon fills with it (how far out of a mass lock, radiators moving, a drive charging). */
  progress?: number;
}

export interface HudSnapshot {
  /** The pause menu (Esc), while it's up: the switches it shows. */
  pause: { sound: boolean; names: boolean; system: string; credits: string } | null;
  /** The system map is open: the flight HUD steps aside (render/SystemMap.ts). */
  mapOpen: boolean;
  lamps: Lamp[];
  helpVisible: boolean;
  /** The save (save.ts): when it was last written, and whether "new game" is armed. */
  save: { status: string; confirm: boolean };
  info: InfoView | null;
  showRelock: boolean;
  toast: { text: string; kind: MsgKind; visible: boolean };
  /** Entry heating glow at the screen's edges, 0…1 (sim/atmosphere.ts): 10 MW → 0, 1 GW → 1. */
  plasma: number;
  location: LocationView;
  flight: FlightView;
  target: TargetView;
  systems: SystemsView;
  planner: PlannerView | null;
  autopilot: AutopilotView | null;
  avionics: AvionicsSlotView[] | null; // the ship stats panel (U), when open
  electrical: ElectricalView | null; // its electrical section
  influences: InfluencesView | null;
  outfit: OutfitView | null;
  radar: RadarView | null;
  cargo: CargoView | null;
  contracts: ContractsView | null;
  /** Docked at a station: its name, the pad, and what the station is doing for the ship. */
  docked: {
    station: string;
    pad: number;
    notes: string[];
    sky: boolean;
    hullFull: boolean;
    tanksFull: boolean;
    credits: string;
    refuel: string;
    repair: string;
    cargo: string | null;
    /** The station window's open tab, and its Trading and Contracts contents. */
    tab: 'trade' | 'services' | 'contracts' | 'outfit';
    trade: { id: 'nife' | 'cobalt' | 'pgm'; name: string; have: string; price: string; vs: { text: string; up: boolean }; value: string; empty: boolean }[];
    jobs: ContractsView | null;
    outfit: OutfitView | null;
    /** Services: each fuel (kg now and full, this station's Cr/kg) and your credits, for the refuel sliders; the hull. */
    fuels: { id: 'prop' | 'exotic' | 'o2'; name: string; haveKg: number; capKg: number; price: number }[];
    creditsN: number;
    hull: { pct: string; frac: number };
  } | null;
  nav: NavView | null;
  guide: GuideView | null;
}

/** The cargo window (Shift+I): the hold and the tanks, what they're worth, and what to do with them. */
export interface CargoView {
  /** The hold: "12.4 t / 200 t", and how full (0…1). */
  used: string;
  frac: number;
  items: {
    id: 'nife' | 'cobalt' | 'pgm';
    name: string;
    mass: string;
    /** Share of the hold's capacity (0…1), for the stacked bar. */
    frac: number;
    price: string; // Cr/kg, here if docked, else list
    value: string;
    empty: boolean;
  }[];
  /** Total value, and whose prices ("at Newton Orbital" or "list prices"). */
  total: string;
  where: string;
  credits: string;
  tanks: { name: string; value: string; frac: number; kind: 'prop' | 'exotic' | 'o2' }[];
  /** What the load costs in flight: ship mass and Δv left, and how much the hold takes off it. */
  mass: string;
  dv: string;
  /** The laser's metal catch right now, if it's cutting. */
  mining: string | null;
  docked: boolean;
  /** Contract crates in the hold (sim/contracts.ts): what, how much, and where they're going. */
  crates: { what: string; mass: string; to: string }[];
  /** A jettison waiting for its second click. */
  armed: 'nife' | 'cobalt' | 'pgm' | null;
}

/** A job, on the board or yours (sim/contracts.ts). */
export interface JobView {
  id: string;
  kind: 'haul' | 'courier' | 'metal';
  title: string; // "Haul 24 t of optics"
  route: string; // "to Newton Orbital · 1.20 AU" or "to Kepler Hub, Arden · 6.3 ly"
  client: string;
  reward: string;
  /** Time allowed (board) or left (yours), and whether it's getting short. */
  time: { text: string; warn: boolean };
  /** Board: why it can't be taken. Yours: metal progress ("12.3 t of 20 t in the hold"). */
  note: string | null;
  canDeliver: boolean;
  /** A metal order you hold: how much of it is in the hold (0…1), for its bar; else null. */
  progress: number | null;
  /** Its destination is elsewhere: the nav computer can plot it. */
  canPlot: boolean;
  armed: boolean; // abandoning: waiting for the second click
}

/** The contracts window (Shift+J): the board where you're docked, and your jobs. */
export interface ContractsView {
  station: string | null;
  board: JobView[];
  mine: JobView[];
  max: number;
  credits: string;
  /** Time to the next board. */
  refresh: string;
}
