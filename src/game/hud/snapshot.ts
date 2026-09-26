/* Turns game state into the display strings and flags the HUD shows. */
import { NORMAL_ACC, NORMAL_BOOST, NORMAL_MAX, SHIP, ftlBurn, jumpCost } from '../constants';
import { fmtClock, fmtCoord, fmtDist, fmtFlow, fmtMass, fmtPower, fmtSpeed, fmtSpeedText, fmtTime } from '../format';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { orbitElements } from '../sim/gravity';
import { guideEta, type Guide } from '../sim/guide';
import { transitState } from '../sim/hyperspace';
import { galPos } from '../sim/navigation';
import { evalPlan } from '../sim/orbits';
import { deltaVLeft, shipMass } from '../sim/resources';
import { buildInfo } from './info';
import type { FlightView, GuideView, HudSnapshot, NavigationView, PlannerView, SystemsView, TargetView } from './types';

const tmp = new THREE.Vector3();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function buildSnapshot(g: Game): HudSnapshot {
  return {
    started: g.started,
    helpVisible: g.helpVisible,
    info: g.infoVisible && g.target ? buildInfo(g, g.target) : null,
    showRelock: g.started && !g.pointerLocked,
    toast: { text: g.msg.text, kind: g.msg.kind, visible: g.msg.on },
    nav: navigation(g),
    flight: flight(g),
    target: target(g),
    systems: systems(g),
    planner: planner(g),
    guide: g.guide ? guide(g.guide) : null,
  };
}

function navigation(g: Game): NavigationView {
  const { ship } = g;
  const st = g.cur.sys.star;
  const gp = galPos(g);
  return {
    clock: fmtClock(g.simTime),
    system: g.cur.sys.name,
    star: `${st.spec} · ${st.R.toFixed(2)} R☉ · ${Math.round(st.T)} K`,
    galactic: `${gp.x.toFixed(2)}  ${gp.y.toFixed(2)}  ${gp.z.toFixed(2)} ly`,
    x: fmtCoord(ship.pos.x),
    y: fmtCoord(ship.pos.y),
    z: fmtCoord(ship.pos.z),
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
  if (ship.mode === 'ftl') return ['FTL DRIVE', 'ftl'];
  if (ship.landed) return ['LANDED', ''];
  return ['NORMAL SPACE', ''];
}

function flight(g: Game): FlightView {
  const { ship, keys, jump } = g;
  const [mode, modeClass] = flightMode(g);
  const [speed, speedUnit] = jump && jump.phase === 'tunnel' ? [transitState(jump).speed.toFixed(2), 'LIGHT-YEARS / S · HYPERSPACE'] : fmtSpeed(g.curSpeed);
  const unit = g.refFrame && ship.mode === 'normal' ? `${speedUnit} · REL. ${g.refFrame.name.toUpperCase()}` : speedUnit;
  let barFrac: number, barLabel: string, barValue: string;
  const barFtl = ship.mode === 'ftl';
  if (barFtl) {
    barFrac = ship.throttle;
    barLabel = ship.cruise ? 'THROTTLE · CRUISE' : 'THROTTLE';
    barValue = Math.round(ship.throttle * 100) + '%';
  } else {
    const boost = !!(keys.ShiftLeft || keys.ShiftRight);
    barFrac = Math.min(1, g.curSpeed / (boost ? NORMAL_BOOST : NORMAL_MAX));
    barLabel = boost ? 'BOOST' : 'SPEED / LIMIT';
    barValue = Math.round(barFrac * 100) + '%';
  }
  const gr = ship.grav;
  let gravity;
  if (gr && ship.mode === 'normal' && !ship.dead) {
    const gs = gr.g / 9.80665;
    gravity = { text: `${gs < 0.01 ? gs.toExponential(1) : gs.toFixed(gs < 1 ? 3 : 2)} G · ${gr.body.name.toUpperCase()}`, warn: gr.g > NORMAL_ACC };
  } else {
    gravity = { text: gr ? `${gr.body.name.toUpperCase()} WELL` : '—' };
  }
  return {
    mode, modeClass, speed, unit, barFrac, barFtl, barLabel, barValue,
    flightAssist: { text: (ship.fa ? 'FLIGHT ASSIST ON' : 'FLIGHT ASSIST OFF') + (ship.decoupled ? ' · DECOUPLED' : ''), warn: !ship.fa || ship.decoupled },
    gravity,
  };
}

function target(g: Game): TargetView {
  const { ship } = g;
  const view: TargetView = {
    type: '', body: 'None · press T', distance: '—', eta: '—',
    nearest: { text: '—' }, vertical: { text: '—' }, orbit: { text: '—' }, jump: 'None · press N',
  };
  const t = g.target;
  if (t) {
    const d = t.pos.distanceTo(ship.pos) - t.radius;
    view.body = t.name;
    view.type = t.typeName.toUpperCase();
    view.distance = fmtDist(d);
    const dir = tmp.subVectors(t.pos, ship.pos).normalize();
    const vel = ship.mode === 'ftl' ? ship.travelDir.clone().multiplyScalar(ship.ftlSpeed) : ship.vel.clone();
    vel.add(g.frameBody.vel).sub(t.vel); // everything moves, so close on the target in its own frame
    const closing = vel.dot(dir);
    view.eta = closing > 1 ? fmtTime(d / closing) : 'not closing';
  }
  const near = g.nearest;
  if (near) view.nearest = { text: `${near.name} · ${fmtDist(g.nearestAlt)}`, warn: near.kind !== 'star' ? g.nearestAlt < 2e4 : g.nearestAlt < near.radius };
  if (g.jumpDest) view.jump = `${g.jumpDest.name} · ${g.jumpDest.star.spec} · ${g.jumpDest.pos.distanceTo(galPos(g)).toFixed(2)} ly`;

  // vertical speed and orbit relative to the body pulling on us
  const gr = ship.grav,
    ap = ship.ap;
  if (gr && ship.mode === 'normal' && !ship.dead) {
    const oe = orbitElements(ship, gr.body);
    const alt = oe.r - gr.body.radius;
    let vs = `${oe.vr > -0.5 ? '+' : '−'}${fmtSpeedText(Math.abs(oe.vr))}`;
    let impact = false;
    if (oe.vr < -1 && oe.pe < gr.body.radius && !ship.landed && !ap) {
      const tt = (oe.vr + Math.sqrt(oe.vr * oe.vr + 2 * gr.g * alt)) / gr.g;
      vs += ` · impact ${fmtTime(tt)}`;
      impact = true;
    }
    view.vertical = { text: vs, warn: impact };
    let orb: string;
    if (ship.landed) orb = `on the surface of ${gr.body.name}`;
    else if (ap && ap.type === 'hold' && ap.settled) orb = 'hovering on thrusters';
    else if (gr.g < 0.02 && !ap) orb = 'negligible gravity';
    else if (oe.escape) orb = `escape trajectory · Pe ${fmtDist(oe.pe - gr.body.radius)}`;
    else if (oe.pe < gr.body.radius) orb = `suborbital · Ap ${fmtDist(oe.ap - gr.body.radius)}`;
    else orb = `Pe ${fmtDist(oe.pe - gr.body.radius)} · Ap ${fmtDist(oe.ap - gr.body.radius)}`;
    view.orbit = { text: orb, warn: !oe.escape && oe.pe < gr.body.radius && !ship.landed && !ap && gr.g >= 0.02 };
  } else {
    view.orbit = { text: ship.mode === 'ftl' ? 'in FTL' : '—' };
  }
  return view;
}

function systems(g: Game): SystemsView {
  const { ship, power } = g;
  const refLy = g.jumpDest ? g.jumpDest.pos.distanceTo(galPos(g)) : 15;
  const ftlRate = ship.mode === 'ftl' ? ftlBurn(ship.ap ? 1 : ship.throttle) : 0;
  const net = power.net;
  let solar: string;
  if (power.shadow) solar = `0 kW · in shadow`;
  else {
    const off = (Math.acos(Math.max(-1, Math.min(1, power.cos))) * 180) / Math.PI;
    solar = `${fmtPower(power.solar)} · ${off.toFixed(0)}° off${ship.sunTrack ? ' · track' : ''}`;
  }
  let note = '';
  if (ship.tanker) note = `Tanker arriving in ${Math.ceil(ship.tanker.t)} s · hold still`;
  else if (ship.scoop) note = ship.scoop;
  else if (ship.prop <= 0) note = 'No propellant. Press K for a tanker, or glide to ice, a gas giant or a star.';
  else if (ship.batt <= 0) note = 'Battery flat. Turn the panels to the star (P).';
  return {
    mass: `SHIP MASS ${fmtMass(shipMass(ship))}`,
    prop: `${fmtMass(ship.prop)} / ${fmtMass(SHIP.propCap)}`,
    propFrac: ship.prop / SHIP.propCap,
    deltaV: `Δv left ${fmtSpeedText(deltaVLeft(ship))}`,
    flow: { text: `burn ${fmtFlow(ship.burnRate)}`, warn: ship.burnRate > 1 && ship.prop / Math.max(ship.burnRate, 1e-9) < 300 },
    exotic: `${fmtMass(ship.exotic)} / ${fmtMass(SHIP.exoticCap)}`,
    exoticFrac: ship.exotic / SHIP.exoticCap,
    jumps: `${Math.floor(ship.exotic / jumpCost(refLy))} jumps of ${refLy.toFixed(1)} ly`,
    exoticRate: ship.mode === 'ftl' ? `burn ${fmtFlow(ftlRate)} · ${fmtTime(ship.exotic / ftlRate)}` : 'drive idle',
    batt: `${ship.batt.toFixed(1)} / ${SHIP.battCap} kWh`,
    battFrac: ship.batt / SHIP.battCap,
    net: { text: `${net >= 0 ? '+' : '−'}${fmtPower(Math.abs(net))} ${net >= 0 ? 'charging' : 'draining'}`, warn: net < 0 },
    battTime:
      net < -0.5
        ? `empty in ${fmtTime((ship.batt / -net) * 3600)}`
        : net > 0.5 && ship.batt < SHIP.battCap - 0.05
          ? `full in ${fmtTime(((SHIP.battCap - ship.batt) / net) * 3600)}`
          : '',
    solar: { text: solar, warn: !!power.shadow || power.cos <= 0 },
    load: fmtPower(power.draw),
    note,
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
