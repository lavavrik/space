/* Turns game state into the display strings and flags the HUD shows. */
import { NORMAL_ACC, NORMAL_BOOST, NORMAL_MAX, SHIP, ftlBurn, jumpCost } from '../constants';
import { fmtClock, fmtDist, fmtFlow, fmtMass, fmtPower, fmtSpeed, fmtSpeedText, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { holdPoint, orbitVelErr } from '../sim/autopilot';
import { velRel } from '../sim/frame';
import { orbitElements, orbitElementsRel } from '../sim/gravity';
import { guideEta, type Guide } from '../sim/guide';
import { transitState } from '../sim/hyperspace';
import { galPos } from '../sim/navigation';
import { evalPlan } from '../sim/orbits';
import { deltaVLeft } from '../sim/resources';
import { buildInfo } from './info';
import type { AutopilotView, FlightView, GuideView, HudSnapshot, LocationView, Pill, PlannerView, Readout, SystemsView, TargetView } from './types';

const tmp = new THREE.Vector3();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function buildSnapshot(g: Game): HudSnapshot {
  return {
    started: g.started,
    helpVisible: g.helpVisible,
    info: g.infoVisible && g.target ? buildInfo(g, g.target) : null,
    showRelock: g.started && !g.pointerLocked,
    toast: { text: g.msg.text, kind: g.msg.kind, visible: g.msg.on },
    location: location(g),
    flight: flight(g),
    target: target(g),
    systems: systems(g),
    planner: planner(g),
    autopilot: g.apPanel && g.ship.ap ? autopilotView(g) : null,
    guide: g.guide ? guide(g.guide) : null,
  };
}

function location(g: Game): LocationView {
  const st = g.cur.sys.star;
  const gp = galPos(g);
  const d = g.jumpDest;
  return {
    system: g.cur.sys.name,
    star: `${st.spec} · ${st.R.toFixed(2)} R☉ · ${Math.round(st.T)} K`,
    sub: `${gp.x.toFixed(2)} ${gp.y.toFixed(2)} ${gp.z.toFixed(2)} ly · ${fmtClock(g.simTime)}`,
    jump: d ? { text: `JUMP → ${d.name} · ${d.star.spec} · ${d.pos.distanceTo(gp).toFixed(1)} ly` } : { text: 'N or click a star to set a jump · Tab for controls', warn: false },
  };
}

function flightMode(g: Game): [string, FlightView['modeClass']] {
  const { ship, jump } = g;
  const ap = ship.ap;
  if (ship.dead) return ['SHIP DESTROYED', 'warn'];
  if (ap && ap.phase === 'transfer') return ['AUTOPILOT · FTL TRANSFER', 'ftl'];
  if (ap && ap.phase === 'insert') {
    const hold = ap.type === 'hold';
    if (ap.settled) return [hold ? 'AUTOPILOT · HOLDING' : 'AUTOPILOT · IN ORBIT', 'ftl'];
    return [hold ? 'AUTOPILOT · MOVING TO HOLD' : 'AUTOPILOT · ORBIT INSERTION', 'ftl'];
  }
  if (jump && jump.phase === 'tunnel') return ['HYPERSPACE', 'ftl'];
  if (jump) return [`HYPERDRIVE ${jump.t.toFixed(1)}`, 'ftl'];
  if (ship.ftlCharge > 0) return [`FTL CHARGING ${ship.ftlCharge.toFixed(1)}`, 'ftl'];
  if (ship.mode === 'ftl') return ['FTL', 'ftl'];
  if (ship.landed) return ['LANDED', ''];
  return ['NORMAL SPACE', ''];
}

function flight(g: Game): FlightView {
  const { ship, keys, jump } = g;
  const [mode, modeClass] = flightMode(g);
  const [speed, speedUnit] = jump && jump.phase === 'tunnel' ? [transitState(jump).speed.toFixed(2), 'LY / S'] : fmtSpeed(g.curSpeed);
  const unit = g.refFrame && ship.mode === 'normal' ? `${speedUnit} · REL. ${g.refFrame.name.toUpperCase()}` : speedUnit === 'TIMES LIGHT SPEED (C)' ? '× LIGHT SPEED' : speedUnit;
  // in hyperspace: just the transit, none of the local flight readouts
  if (jump && jump.phase === 'tunnel') {
    const st = transitState(jump);
    return { mode, modeClass, speed, unit, barFrac: st.u, barFtl: true, barLabel: 'TRANSIT', barValue: `${st.left.toFixed(1)} ly to go`, alt: null, orbit: null, pills: [] };
  }
  let barFrac: number, barLabel: string, barValue: string;
  const barFtl = ship.mode === 'ftl';
  if (barFtl) {
    barFrac = ship.throttle;
    barLabel = 'THROTTLE';
    barValue = Math.round(ship.throttle * 100) + '%';
  } else {
    const boost = !!(keys.ShiftLeft || keys.ShiftRight);
    barFrac = Math.min(1, g.curSpeed / (boost ? NORMAL_BOOST : NORMAL_MAX));
    barLabel = boost ? 'BOOST' : 'SPEED LIMIT';
    barValue = Math.round(barFrac * 100) + '%';
  }

  // altitude, vertical speed and orbit, relative to the body pulling on you (skipped far out in a star's pull)
  const gr = ship.grav,
    ap = ship.ap;
  let alt: Readout | null = null,
    orbit: Readout | null = null;
  if (gr && ship.mode === 'normal' && !ship.dead && (gr.body.kind !== 'star' || gr.g >= 0.02)) {
    const b = gr.body;
    const oe = orbitElements(ship, b);
    const h = oe.r - b.radius;
    const up = oe.vr > -0.5;
    let impact = '';
    if (oe.vr < -1 && oe.pe < b.radius && !ship.landed && !ap) impact = ` · impact ${fmtTime((oe.vr + Math.sqrt(oe.vr * oe.vr + 2 * gr.g * h)) / gr.g)}`;
    alt = { text: `ALT ${fmtDist(h)} · ${up ? '▲' : '▼'} ${fmtSpeedText(Math.abs(oe.vr))}${impact}`, warn: !!impact };
    if (ship.landed) orbit = { text: `LANDED ON ${b.name.toUpperCase()}` };
    else if (ap && ap.type === 'hold' && ap.settled) orbit = { text: 'HOVERING ON THRUSTERS' };
    else if (gr.g < 0.02 && !ap) orbit = null;
    else if (oe.escape) orbit = { text: `ESCAPING ${b.name.toUpperCase()}` };
    else if (oe.pe < b.radius) orbit = { text: `SUBORBITAL · AP ${fmtDist(oe.ap - b.radius)}`, warn: !ap };
    else orbit = { text: `IN ORBIT · PE ${fmtDist(oe.pe - b.radius)} · AP ${fmtDist(oe.ap - b.radius)}` };
  }

  const pills: Pill[] = [{ text: ship.fa ? 'FA ON' : 'FA OFF', kind: ship.fa ? 'on' : 'warn' }];
  if (ship.decoupled) pills.push({ text: 'DECOUPLED', kind: 'warn' });
  if (ship.mode === 'ftl') pills.push({ text: ship.cruise ? 'CRUISE' : 'HOLD W', kind: ship.cruise ? 'ftl' : '' });
  if (gr && ship.mode === 'normal' && !ship.dead) {
    const gs = gr.g / 9.80665;
    pills.push({ text: `${gs < 0.01 ? gs.toExponential(1) : gs.toFixed(gs < 1 ? 2 : 1)} g`, kind: gr.g > NORMAL_ACC ? 'warn' : '' });
  }
  return { mode, modeClass, speed, unit, barFrac, barFtl, barLabel, barValue, alt, orbit, pills };
}

function target(g: Game): TargetView {
  const { ship } = g;
  const t = g.target;
  if (!t) return { name: 'NO TARGET', type: 'T · G · CLICK', distance: '—', eta: '', none: true };
  const d = t.pos.distanceTo(ship.pos) - (t.kind === 'station' ? t.size / 2 : t.radius);
  const dir = tmp.subVectors(t.pos, ship.pos).normalize();
  const vel = ship.mode === 'ftl' ? ship.travelDir.clone().multiplyScalar(ship.ftlSpeed) : ship.vel.clone();
  vel.add(g.frameBody.vel).sub(t.vel); // everything moves, so close on the target in its own frame
  const closing = vel.dot(dir);
  return { name: t.name, type: t.kind === 'station' ? 'ORBITAL STATION' : t.typeName.toUpperCase(), distance: fmtDist(d), eta: closing > 1 ? `ETA ${fmtTime(d / closing)}` : 'NOT CLOSING', none: false };
}

function systems(g: Game): SystemsView {
  const { ship, power } = g;
  const refLy = g.jumpDest ? g.jumpDest.pos.distanceTo(galPos(g)) : 15;
  const net = power.net;
  const netText = `${net >= 0 ? '+' : '−'}${fmtPower(Math.abs(net))}`;
  const battTime = net < -0.5 ? ` · empty in ${fmtTime((ship.batt / -net) * 3600)}` : net > 0.5 && ship.batt < SHIP.battCap - 0.05 ? ` · full in ${fmtTime(((SHIP.battCap - ship.batt) / net) * 3600)}` : '';
  const ftlRate = ship.mode === 'ftl' ? ftlBurn(ship.ap ? 1 : ship.throttle) : 0;
  let note: Readout | null = null;
  if (ship.tanker) note = { text: `Tanker arriving in ${Math.ceil(ship.tanker.t)} s · hold still` };
  else if (ship.scoop) note = { text: ship.scoop };
  else if (ship.prop <= 0) note = { text: 'No propellant · K for a tanker, or skim a gas giant or star', warn: true };
  else if (ship.batt <= 0) note = { text: 'Battery flat · P turns the panels to the star', warn: true };
  else if (power.shadow) note = { text: `In ${power.shadow.name}'s shadow · no solar power` };
  const burnLow = ship.burnRate > 1 && ship.prop / Math.max(ship.burnRate, 1e-9) < 300;
  return {
    gauges: [
      { label: 'H₂', value: fmtMass(ship.prop), frac: ship.prop / SHIP.propCap, sub: { text: ship.burnRate > 0.01 ? `Δv ${fmtSpeedText(deltaVLeft(ship))} · burning ${fmtFlow(ship.burnRate)}` : `Δv ${fmtSpeedText(deltaVLeft(ship))} left`, warn: burnLow } },
      { label: 'EXOTIC', value: fmtMass(ship.exotic), frac: ship.exotic / SHIP.exoticCap, variant: 'ftl', sub: { text: ship.mode === 'ftl' ? `burning ${fmtFlow(ftlRate)} · ${fmtTime(ship.exotic / ftlRate)} left` : `${Math.floor(ship.exotic / jumpCost(refLy))} jumps of ${refLy.toFixed(0)} ly` } },
      { label: 'BATTERY', value: `${ship.batt.toFixed(0)} kWh`, frac: ship.batt / SHIP.battCap, variant: 'batt', sub: { text: `${netText}${battTime}`, warn: net < -0.5 } },
    ],
    note,
  };
}

function autopilotView(g: Game): AutopilotView {
  const { ship } = g;
  const ap = ship.ap!;
  const b = ap.body,
    R = b.radius;
  const label = { equatorial: 'Equatorial orbit', polar: 'Polar orbit', sync: 'Stationary orbit', hold: 'Hold position' }[ap.type];
  const [mode] = flightMode(g);
  const rv = ship.pos.clone().sub(b.pos);
  const v = velRel(g, b);
  const used = Math.max(0, ap.prop0 - ship.prop);
  const dv = SHIP.ve * Math.log((SHIP.dry + ap.prop0) / (SHIP.dry + ship.prop));
  const rows: [string, string | Readout][] = [];
  if (ap.type === 'hold') {
    const off = holdPoint(ap).distanceTo(ship.pos);
    rows.push(['TARGET', `${fmtDist(ap.r0 - R)} above ${b.name}`]);
    rows.push(['OFF THE POINT', { text: fmtDist(off), warn: ap.settled && off > 1000 }]);
    rows.push(['DRIFT', fmtSpeedText(v.length())]);
    const gr = ship.grav ? ship.grav.g : 0;
    rows.push(['HOVER COST', `${fmtFlow(ship.burnRate)} · tank lasts ${fmtTime(deltaVLeft(ship) / Math.max(gr, 1e-9))}`]);
  } else {
    const oe = orbitElementsRel(rv, v, b.mu);
    rows.push(['TARGET', `${fmtDist(ap.r0 - R)} · period ${fmtTime(ap.period)}`]);
    rows.push(['CURRENT', oe.escape ? 'escape trajectory' : `Pe ${fmtDist(oe.pe - R)} · Ap ${fmtDist(oe.ap - R)}`]);
    const dAlt = rv.length() - ap.r0;
    const dPlane = Math.abs(rv.dot(ap.n!));
    const dVel = orbitVelErr(g, ap);
    const big = (x: number, lim: number) => ap.settled && x > lim;
    rows.push(['ALTITUDE OFF', { text: `${dAlt >= 0 ? '+' : '−'}${fmtDist(Math.abs(dAlt))}`, warn: big(Math.abs(dAlt), Math.max(2000, ap.r0 * 0.004)) }]);
    rows.push(['PLANE OFF', { text: fmtDist(dPlane), warn: big(dPlane, 5000) }]);
    rows.push(['SPEED OFF', { text: fmtSpeedText(dVel), warn: big(dVel, 20) }]);
  }
  rows.push(['ENGAGED', `${fmtTime(g.simTime - ap.t0)} · Δv ${fmtSpeedText(dv)} · ${fmtMass(used)} H₂`]);
  return {
    title: label,
    sub: `${b.name} · ${ap.type === 'hold' ? fmtDist(ap.r0 - R) + ' up' : fmtDist(ap.r0 - R) + ' · ' + fmtTime(ap.period)}`,
    state: { text: mode.replace('AUTOPILOT · ', ''), warn: false },
    rows,
    confirm: g.apConfirm > 0,
  };
}

function planner(g: Game): PlannerView | null {
  const p = g.planner;
  if (!p) return null;
  const { ship } = g;
  const b = p.body,
    ev = evalPlan(p, ship);
  const far = Math.abs(ship.pos.distanceTo(b.pos) - ev.r0) > 3e6;
  return {
    body: `${b.name} · ${b.typeName}`,
    type: p.type,
    alt: fmtDist(ev.r0 - b.radius) + (p.type === 'sync' ? ' (fixed)' : ''),
    period: isFinite(ev.period) ? fmtTime(ev.period) : 'not orbiting',
    speed: ev.speed ? fmtSpeed(ev.speed).join(' ').replace('TIMES LIGHT SPEED (C)', 'c').toLowerCase() : '0 m/s',
    dir: p.type === 'hold' ? '—' : p.type === 'sync' ? 'with rotation (required)' : p.dir > 0 ? 'prograde (with rotation)' : 'retrograde',
    note: { text: ev.note || `Autopilot flies you there${far ? ', using FTL for the long leg' : ''}.`, warn: !ev.ok || !!ev.warn },
  };
}

function guide(man: Guide): GuideView {
  const steps = man.steps.map((s) => {
    let eta = '';
    if (s.st === 'done') eta = s.time ? `took ${fmtTime(s.time)}` : 'done';
    else if (s.st === 'active') eta = s.ongoing ? 'ongoing' : isFinite(s.eta) ? fmtTime(s.eta) : 'estimating';
    if (s.st === 'active') {
      try {
        s.detailText = s.detail();
      } catch {
        // keep the last detail if the step can't describe itself this frame
      }
    }
    const mates = man.steps.filter((o) => o.group === s.group);
    const span = mates.length > 1 ? ` · steps ${mates[0].num}–${mates[mates.length - 1].num} together` : '';
    return {
      num: s.num,
      className: `step ${s.kind} ${s.st}`,
      badge: s.st === 'done' ? '✓' : String(s.num),
      title: s.titleFn ? s.titleFn() : (s.title ?? ''),
      eta,
      detail: s.detailText,
      prog: clamp01(s.prog),
      extra: s.dv > 0.5 ? `Δv ${fmtSpeedText(s.dv)} · ${fmtMass(s.prop)} H₂${span}` : '',
    };
  });
  let eta: string;
  let end = null;
  if (man.end) {
    eta = man.end === 'done' ? 'COMPLETE' : 'ABORTED';
    end = { text: man.endText || '', warn: man.end !== 'done' };
  } else {
    const { total, unknown, empty } = guideEta(man);
    eta = empty ? 'HOLDING' : `ETA ${total > 0 ? fmtTime(total) : ''}${unknown ? (total > 0 ? '+' : 'estimating') : ''}`;
  }
  return {
    title: man.title,
    sub: man.sub,
    eta,
    steps,
    end,
    foot: `Total Δv ${fmtSpeedText(man.dv)} · ${fmtMass(man.prop)} H₂`,
    time: fmtTime(man.elapsed),
  };
}
