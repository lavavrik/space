/* Maneuver guide: a read-only checklist of what the ship is doing. Each step reports progress
   as 1 − error/initial error, and an ETA from how fast that error is shrinking (or a timer). */
import { AP_ACC, AP_TAU, SHIP } from '../constants';
import { fmtDist, fmtFlow, fmtMass, fmtPower, fmtSpeedText, fmtTime } from '../format';
import type { Game } from '../Game';
import type { Autopilot, Jump, Tanker } from '../types';
import { apGeom, apInsertion, approachTime, holdPoint, orbitVelErr, profileOf, RDV_STANDOFF } from './autopilot';
import { velRel } from './frame';
import { orbitElements } from './gravity';
import { deltaVLeft, shipMass } from './resources';

export type StepState = 'pending' | 'active' | 'done';
export type StepKind = 'thrust' | 'ftl';

interface StepInit {
  title?: string;
  titleFn?: () => string;
  kind?: StepKind;
  /** Steps sharing a group run at the same time. */
  group?: string;
  /** Never completes (e.g. station-keeping). */
  ongoing?: boolean;
  active: () => boolean;
  done: () => boolean;
  /** Remaining error; null when it can't be measured. */
  err: () => number | null;
  /** Direct ETA estimate, used instead of the error rate. */
  etaFn?: () => number;
  /** Duration to assume while the step is still pending. */
  guess?: () => number;
  detail: () => string;
}

export interface GuideStep extends StepInit {
  kind: StepKind;
  group: string;
  ongoing: boolean;
  num: number;
  st: StepState;
  err0: number | null;
  last: number | null;
  rate: number;
  eta: number;
  prog: number;
  dv: number;
  prop: number;
  time: number;
  detailText: string;
}

type AbortResult = string | { ok: string } | null;

export interface Guide {
  title: string;
  sub: string;
  steps: GuideStep[];
  abort: () => AbortResult;
  doneText: string | null;
  elapsed: number;
  dv: number;
  prop: number;
  lastProp: number;
  end: 'done' | 'aborted' | null;
  endT: number;
  endText: string | null;
}

function mkStep(o: StepInit): GuideStep {
  return {
    st: 'pending', err0: null, last: null, rate: 0, eta: Infinity, prog: 0, dv: 0, prop: 0, time: 0, num: 0,
    kind: 'thrust', group: '', ongoing: false, detailText: '',
    ...o,
  };
}

function startGuide(g: Game, init: { title: string; sub: string; abort: () => AbortResult; doneText: string | null; steps: GuideStep[] }) {
  const guide: Guide = { elapsed: 0, dv: 0, prop: 0, lastProp: g.ship.prop, end: null, endT: 0, endText: null, ...init };
  guide.steps.forEach((s, i) => {
    s.num = i + 1;
    if (!s.group) s.group = 'g' + i;
  });
  g.guide = guide;
  g.invalidateHud();
}

function ftlStepsFor(g: Game, ap: Autopilot, steps: GuideStep[]) {
  const { ship } = g;
  const b = ap.body;
  if (ap.phase === 'charge') {
    steps.push(mkStep({
      title: 'Charge FTL drive', kind: 'ftl',
      active: () => ap.phase === 'charge', done: () => ap.phase !== 'charge',
      // ftlCharge is seconds at full power; the bus may give less (sim/power.ts)
      err: () => ship.ftlCharge, etaFn: () => (ship.ftlCharge * SHIP.ftlChargeKW) / Math.max(g.power.chargeKW, 1),
      detail: () => `${fmtPower(g.power.chargeKW || SHIP.ftlChargeKW)} of ${fmtPower(SHIP.ftlChargeKW)} · ${SHIP.ftlChargeKg} kg exotic matter`,
    }));
  }
  if (ap.phase === 'charge' || ap.phase === 'transfer') {
    steps.push(mkStep({
      title: `FTL transfer to ${b.name}`, kind: 'ftl',
      active: () => ap.phase === 'transfer', done: () => ap.phase === 'insert',
      err: () => apInsertion(ship, ap).P.distanceTo(ship.pos),
      // speed is held near 0.8 × remaining distance, so distance decays as e^(−0.8 t)
      etaFn: () => {
        const { P, rT } = apInsertion(ship, ap);
        const d = P.distanceTo(ship.pos);
        return Math.log(Math.max(1, d / Math.max(30e3, rT * 0.01))) / 0.8 + (ship.ftlSpeed < 1e5 ? 4 : 0);
      },
      detail: () => `Drop point ${fmtDist(apInsertion(ship, ap).rT - b.radius)} up · ${fmtDist(apInsertion(ship, ap).P.distanceTo(ship.pos))} to go`,
    }));
  }
  for (const s of steps) s.guess = s.etaFn;
}

export function startOrbitGuide(g: Game, ap: Autopilot) {
  const { ship } = g;
  const b = ap.body,
    steps: GuideStep[] = [];
  ftlStepsFor(g, ap, steps);
  const ins = () => ap.phase === 'insert';
  const prof = profileOf(ship); // the fitted orbit computer's approach profile
  if (ap.type === 'rendezvous') {
    const st = ap.station!;
    const dist = () => Math.max(0, st.pos.distanceTo(ship.pos) - RDV_STANDOFF);
    const dv = () => velRel(g, b).distanceTo(st.vel.clone().sub(b.vel));
    steps.push(mkStep({
      title: `Close in on ${st.name}`, group: 'rdv', active: ins, done: () => ins() && dist() < 1000, err: dist,
      etaFn: () => approachTime(dist(), prof.radialCap, 1000, prof.acc),
      detail: () => `${fmtDist(dist() + RDV_STANDOFF)} away`,
    }));
    steps.push(mkStep({
      title: 'Match its velocity', group: 'rdv', active: ins, done: () => ap.settled, err: dv,
      detail: () => `${fmtSpeedText(dv())} relative`,
    }));
  } else if (ap.type === 'hold') {
    const dist = () => holdPoint(ap).distanceTo(ship.pos);
    const vRel = () => velRel(g, b).length();
    steps.push(mkStep({
      title: 'Fly to hold point', group: 'move', active: ins, done: () => ins() && dist() < 200, err: dist, etaFn: () => approachTime(dist(), prof.radialCap, 200, prof.acc),
      detail: () => `${fmtDist(dist())} to go · ${fmtDist(ap.r0 - b.radius)} above ${b.name}`,
    }));
    steps.push(mkStep({
      title: 'Cancel velocity', group: 'move', active: ins, done: () => ins() && dist() < 1000 && vRel() < 5, err: vRel, etaFn: () => approachTime(dist(), prof.radialCap, 1000, prof.acc),
      detail: () => `${fmtSpeedText(vRel())} relative to ${b.name}`,
    }));
    steps.push(mkStep({
      title: 'Station-keeping', ongoing: true, active: () => ins() && ap.settled, done: () => false, err: () => null,
      detail: () => {
        const gr = ship.grav ? ship.grav.g : 0;
        return `Fighting ${gr.toFixed(2)} m/s² · burning ${fmtFlow(ship.burnRate)} · tank lasts ${fmtTime(deltaVLeft(ship) / Math.max(gr, 1e-9))}`;
      },
    }));
  } else {
    const R = b.radius,
      vc = Math.sqrt(b.mu / ap.r0);
    const altErr = () => Math.abs(apGeom(ship, ap).r - ap.r0);
    const altDone = Math.max(1000, ap.r0 * 0.002);
    steps.push(mkStep({
      titleFn: () => (apGeom(ship, ap).r > ap.r0 ? 'Descend to orbital altitude' : 'Climb to orbital altitude'),
      group: 'ins', active: ins, done: () => ins() && altErr() < altDone, err: altErr,
      // the approach profile is deterministic, so compute the ETA instead of extrapolating the error
      etaFn: () => approachTime(altErr(), prof.radialCap, altDone, prof.acc),
      detail: () => `${fmtDist(apGeom(ship, ap).r - R)} → ${fmtDist(ap.r0 - R)}`,
    }));
    steps.push(mkStep({
      title: 'Match orbital velocity', group: 'ins', active: ins,
      done: () => ins() && orbitVelErr(g, ap) < Math.max(5, vc * 0.005), err: () => orbitVelErr(g, ap),
      // matched by the autopilot's full thrust in a few seconds (then held as the altitude changes)
      etaFn: () => orbitVelErr(g, ap) / AP_ACC + AP_TAU * Math.log(Math.max(1, orbitVelErr(g, ap) / Math.max(5, vc * 0.005))),
      detail: () => `orbital speed off by ${fmtSpeedText(orbitVelErr(g, ap))} (target ${fmtSpeedText(vc)})`,
    }));
    const planeErr = () => Math.abs(apGeom(ship, ap).rv.dot(ap.n!)) + Math.abs(velRel(g, b).dot(ap.n!)) * 30;
    if (planeErr() > 2000) {
      steps.push(mkStep({
        title: ap.type === 'polar' ? 'Align to polar plane' : 'Align to equator', group: 'ins', active: ins,
        done: () => ins() && planeErr() < 2000, err: planeErr,
        etaFn: () => approachTime(Math.abs(apGeom(ship, ap).rv.dot(ap.n!)), prof.planeCap, 1000, prof.acc),
        detail: () => `${fmtDist(Math.abs(apGeom(ship, ap).rv.dot(ap.n!)))} out of plane`,
      }));
    }
    const insSteps = steps.filter((s) => s.group === 'ins');
    steps.push(mkStep({
      title: 'Circularize and settle', active: () => ins() && insSteps.every((s) => s.st === 'done'), done: () => ap.settled,
      err: () => {
        const oe = orbitElements(ship, b);
        return oe.escape ? null : Math.abs(oe.ap - oe.pe) + Math.abs((oe.ap + oe.pe) / 2 - ap.r0);
      },
      detail: () => {
        const oe = orbitElements(ship, b);
        return oe.escape ? 'on an escape path' : `Pe ${fmtDist(oe.pe - R)} · Ap ${fmtDist(oe.ap - R)}`;
      },
    }));
  }
  const label = { equatorial: 'Equatorial orbit', polar: 'Polar orbit', sync: 'Stationary orbit', hold: 'Hold position', rendezvous: 'Rendezvous' }[ap.type];
  startGuide(g, {
    title: label.toUpperCase(),
    sub: `${b.name} · ${fmtDist(ap.r0 - b.radius)}${ap.period ? ' · period ' + fmtTime(ap.period) : ''}`,
    abort: () => (ship.ap !== ap ? (ship.dead ? 'Ship destroyed' : ap.type === 'hold' && ap.settled ? { ok: 'Hold released' } : 'Autopilot disengaged') : null),
    doneText: ap.type === 'hold' ? null : ap.type === 'rendezvous' ? `Alongside ${ap.station!.name}` : 'Orbit established · no thrust needed to stay',
    steps,
  });
}

export function startJumpGuide(g: Game, j: Jump, ly: number) {
  startGuide(g, {
    title: 'HYPERJUMP',
    sub: `${j.dest.name} · ${j.dest.star.spec} · ${ly.toFixed(2)} ly`,
    abort: () => null,
    doneText: `Arrived at ${j.dest.name}`,
    steps: [
      mkStep({
        title: 'Charge hyperdrive', kind: 'ftl', active: () => g.jump === j && j.phase === 'charge', done: () => g.jump !== j || j.phase !== 'charge',
        err: () => j.t, etaFn: () => (j.t * SHIP.jumpChargeKW) / Math.max(g.power.chargeKW, 1), detail: () => `${fmtPower(SHIP.jumpChargeKW)} from the battery · ${j.cost.toFixed(1)} kg exotic matter`,
      }),
      mkStep({
        title: 'Accelerate out', kind: 'ftl', active: () => g.jump === j && j.phase === 'depart', done: () => g.jump !== j || j.phase === 'tunnel',
        err: () => j.t, etaFn: () => j.t, detail: () => 'leaving the system at an exponentially rising speed',
      }),
      mkStep({
        title: 'Hyperspace transit', kind: 'ftl', active: () => g.jump === j && j.phase === 'tunnel', done: () => g.jump !== j,
        err: () => j.t, etaFn: () => j.t, guess: () => j.dur, detail: () => `${ly.toFixed(2)} light-years in ${j.dur.toFixed(1)} s`,
      }),
    ],
  });
}

export function startTankerGuide(g: Game, tk: Tanker) {
  const { ship } = g;
  startGuide(g, {
    title: 'TANKER RENDEZVOUS',
    sub: 'Hold still below 200 m/s',
    doneText: 'Tanks and battery full',
    abort: () => (ship.tanker !== tk && !tk.docked ? 'Rendezvous cancelled' : null),
    steps: [
      mkStep({
        title: 'Tanker en route', active: () => ship.tanker === tk && tk.t > 8, done: () => !!tk.docked || tk.t <= 8,
        err: () => Math.max(0, tk.t - 8), etaFn: () => Math.max(0, tk.t - 8), detail: () => 'Matching your velocity',
      }),
      mkStep({
        title: 'Dock and transfer fuel', active: () => ship.tanker === tk && tk.t <= 8, done: () => !!tk.docked,
        err: () => tk.t, etaFn: () => tk.t, guess: () => 8,
        detail: () => `H₂ ${fmtMass(SHIP.propCap - ship.prop)} · exotic ${fmtMass(SHIP.exoticCap - ship.exotic)} to load`,
      }),
    ],
  });
}

export function updateGuide(g: Game, dt: number) {
  const man = g.guide;
  if (!man) return;
  const { ship } = g;
  const used = Math.max(0, man.lastProp - ship.prop);
  man.lastProp = ship.prop;
  const dv = used > 0 ? SHIP.ve * Math.log((shipMass(ship) + used) / shipMass(ship)) : 0;
  if (man.end) {
    man.endT -= dt;
    if (man.endT <= 0) g.guide = null;
    return;
  }
  man.elapsed += dt;
  man.dv += dv;
  man.prop += used;
  const why = man.abort();
  if (why) {
    if (typeof why === 'object') {
      man.end = 'done';
      man.endText = why.ok;
    } else {
      man.end = 'aborted';
      man.endText = why;
    }
    man.endT = 6;
    return;
  }
  const charged = new Set<string>(); // steps running together share one Δv tally, kept on the group's first step
  for (const s of man.steps) {
    if (s.st === 'done') continue;
    if (s.done()) {
      s.st = 'done';
      s.prog = 1;
      s.eta = 0;
      continue;
    }
    if (!s.active()) continue;
    s.st = 'active';
    s.time += dt;
    if (!charged.has(s.group)) {
      charged.add(s.group);
      const lead = man.steps.find((o) => o.group === s.group)!;
      lead.dv += dv;
      lead.prop += used;
    }
    const e = s.err();
    if (e == null || !isFinite(e)) {
      s.eta = s.ongoing ? Infinity : s.eta;
      continue;
    }
    if (s.err0 == null || e > s.err0) s.err0 = Math.max(e, 1e-9);
    s.prog = 1 - e / s.err0;
    if (s.last != null) s.rate += ((s.last - e) / dt - s.rate) * Math.min(1, dt * 0.6);
    s.last = e;
    s.eta = s.etaFn ? s.etaFn() : s.rate > 1e-9 ? e / s.rate : Infinity;
  }
  const finite = man.steps.filter((s) => !s.ongoing);
  if (finite.every((s) => s.st === 'done') && !man.steps.some((s) => s.ongoing)) {
    man.end = 'done';
    man.endText = man.doneText;
    man.endT = 12;
  }
}

/** Total ETA: steps in the same group run together (take the longest), groups run in order. */
export function guideEta(man: Guide) {
  let total = 0,
    unknown = false;
  const groups = new Map<string, GuideStep[]>();
  for (const s of man.steps) {
    if (s.st === 'done' || s.ongoing) continue;
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group)!.push(s);
  }
  for (const list of groups.values()) {
    // active steps use their live ETA; pending ones a fixed duration if they have one
    const etas = list.map((s) => (s.st === 'active' ? s.eta : s.guess ? s.guess() : Infinity));
    const known = etas.filter(isFinite);
    if (known.length < list.length) unknown = true;
    if (known.length) total += Math.max(...known);
  }
  return { total, unknown, empty: groups.size === 0 };
}
