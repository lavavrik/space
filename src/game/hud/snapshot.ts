/* Turns game state into the display strings and flags the HUD shows. */
import { AU, FTL_CHARGE_TIME, JUMP_CHARGE_TIME, LY, JUMP_DEPART_TIME, NORMAL_ACC, NORMAL_BOOST, NORMAL_MAX, SHIP, ftlBurn, jumpCost } from '../constants';
import { fmtArea, fmtClock, fmtEnergy, fmtDist, fmtFlow, fmtMass, fmtPower, fmtSpeed, fmtSpeedText, fmtTime } from '../format';
import type { Game } from '../Game';
import type { Station } from '../types';
import { THREE } from '../lib/three';
import { holdPoint, orbitVelErr } from '../sim/autopilot';
import { velRel } from '../sim/frame';
import { orbitElements, orbitElementsRel } from '../sim/gravity';
import { guideEta, type Guide } from '../sim/guide';
import { transitState } from '../sim/hyperspace';
import { NAV_MODES, searchNav } from '../sim/navroute';
import { resolvable, SCAN_STAGE, scanProgress } from '../sim/scanner';
import { galPos } from '../sim/navigation';
import { apLabel, evalPlan } from '../sim/orbits';
import { deltaVLeft, dryMass } from '../sim/resources';
import { battCap, loadOn } from '../sim/power';
import { MASS_LOCK_K, dropAlt, massLock } from '../sim/ftl';
import { ringFrameOf } from '../sim/frame';
import { AUTOSAVE_S, ago } from '../save';
import { surfaceDist, surfaceRadius } from '../sim/terrain';
import { beltLimit, surfaceLimit } from '../sim/flight';
import { TEMP, nextLimit } from '../sim/thermal';
import { BATTERIES, MODULES, PUMP_ON_ABOVE, type BatteryModule, RADIATOR_MAX_ACC, moduleLabel, outfitMass, pumpFitted, radiatorsFitted, type Module } from '../outfit/catalog';
import { outfitter } from '../outfit/fit';
import { SHORE_POWER } from '../sim/docking';
import { RADAR_RANGE, SWEEP, contactLabel, radarClass, radarContacts } from '../sim/radar';
import { unitLabel, type Computer } from '../avionics/catalog';
import { buildInfluences } from './influences';
import { approachView } from './approach';
import { deflectorFitted, fuelCellFitted, guardFitted, laserFitted } from '../outfit/catalog';
import { threatNow } from '../sim/belt';
import { rockLabel } from '../sim/ringRocks';
import { liveProspects, prospectNow } from '../sim/prospect';
import { FC_KWH, FC_OFF, FC_ON, O2_PER_H2, o2Days } from '../sim/oxygen';
import { BOARD_S, MAX_ACTIVE, board, canDeliverMetal, cantTake, reach, type Contract } from '../sim/contracts';
import { FUELS, fuelPrice, CARGO_CAP, COMMODITIES, cargoMass, cargoValue, fmtCr, refuelQuote, repairQuote, sellPrice, type Commodity } from '../sim/economy';
import { fitPrice } from '../outfit/fit';
import { HULL_WARN, heatDamageRate } from '../sim/damage';
import { buildInfo, stationKind } from './info';
import type { ContractsView, JobView, CargoView, AutopilotView, AvionicsSlotView, ElectricalView, ModuleIcon, RadarView, OutfitView, FlightView, GaugeBadge, GaugeView, Lamp, NavView, GuideView, HudSnapshot, LocationView, Pill, PlannerView, Readout, SystemsView, TargetView } from './types';

const tmp = new THREE.Vector3();
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function buildSnapshot(g: Game): HudSnapshot {
  return {
    pause: g.paused ? { sound: !g.audio.muted, names: g.showNames, system: g.cur.sys.name, credits: fmtCr(g.credits) } : null,
    helpVisible: g.helpVisible,
    save: { status: g.savedAt ? `Saved ${ago(g.savedAt)} · autosaves every ${AUTOSAVE_S} s` : `Not saved yet · autosaves every ${AUTOSAVE_S} s`, confirm: g.newGameConfirm > 0 },
    info: g.infoVisible && g.target ? buildInfo(g, g.target) : null,
    showRelock: !g.pointerLocked,
    toast: { text: g.msg.text, kind: g.msg.kind, visible: g.msg.on },
    plasma: g.aero.heatW > 1e7 ? Math.min(1, Math.log10(g.aero.heatW / 1e7) / 2) : 0,
    location: location(g),
    flight: flight(g),
    lamps: lamps(g),
    target: target(g),
    systems: systems(g),
    planner: planner(g),
    autopilot: g.apPanel && g.ship.ap ? autopilotView(g) : null,
    avionics: g.avionicsVisible ? avionicsView(g) : null,
    electrical: g.avionicsVisible ? electricalView(g) : null,
    influences: g.influencesVisible ? buildInfluences(g) : null,
    outfit: g.outfitVisible ? outfitView(g) : null,
    radar: g.radarVisible ? radarView(g) : null,
    cargo: g.cargoVisible ? cargoView(g) : null,
    contracts: g.contractsVisible ? contractsView(g) : null,
    docked: g.dock?.docked
      ? {
          station: g.dock.station.name,
          pad: g.dock.pad + 1,
          notes: [
            `External power ${fmtPower(SHORE_POWER)} · battery charging`,
            `Hull held near room temperature (${g.ship.temp.toFixed(0)} K)`,
            ...(g.dock.station.sky ? ['Catapult: thrown up and flown clear of the air, no input needed'] : []),
          ],
          sky: !!g.dock.station.sky,
          hullFull: g.ship.hull >= 0.999,
          credits: fmtCr(g.credits),
          refuel: fmtCr(refuelQuote(g, g.dock.station).cost),
          repair: fmtCr(repairQuote(g, g.dock.station)),
          cargo: Object.values(g.ship.cargo).some((kg) => (kg ?? 0) > 0.5) ? fmtCr(cargoValue(g, g.dock.station)) : null,
          tab: g.stationTab,
          trade: tradeRows(g, g.dock.station),
          jobs: g.stationTab === 'contracts' ? contractsView(g) : null,
          outfit: g.stationTab === 'outfit' ? outfitView(g) : null,
          fuels: (['prop', 'exotic', 'o2'] as const).map((id) => ({ id, name: { prop: 'Hydrogen', exotic: 'Exotic matter', o2: 'Oxygen (LOX)' }[id], haveKg: g.ship[id], capKg: FUELS[id].cap, price: fuelPrice(g.dock!.station, id) })),
          creditsN: g.credits,
          hull: { pct: `${Math.round(g.ship.hull * 100)} %`, frac: g.ship.hull },
          tanksFull: g.ship.prop >= SHIP.propCap - 1 && g.ship.exotic >= SHIP.exoticCap - 0.01,
        }
      : null,
    nav: g.navPanel || g.route?.running ? navView(g) : null,
    mapOpen: g.map.open,
    guide: g.guide ? guide(g.guide) : null,
  };
}

function location(g: Game): LocationView {
  const st = g.cur.sys.star;
  const gp = galPos(g);
  const d = g.jump?.dest ?? g.jumpDest;
  return {
    system: g.cur.sys.name,
    star: `${st.spec} · ${st.R.toFixed(2)} R☉ · ${Math.round(st.T)} K`,
    sub: `${gp.x.toFixed(2)} ${gp.y.toFixed(2)} ${gp.z.toFixed(2)} ly · ${fmtClock(g.simTime)}`,
    jump: d ? { text: `JUMP → ${d.name} · ${d.star.spec} · ${d.pos.distanceTo(gp).toFixed(1)} ly` } : { text: 'N or click a star to set a jump · U ship · Tab controls', warn: false },
  };
}

function flightMode(g: Game): [string, FlightView['modeClass']] {
  const { ship, jump } = g;
  const ap = ship.ap;
  if (ship.dead) return ['SHIP DESTROYED', 'warn'];
  if (ap && ap.phase === 'transfer') return ['AUTOPILOT · FTL TRANSFER', 'ftl'];
  if (ap && ap.phase === 'insert') {
    const hold = ap.type === 'hold';
    if (ap.type === 'rendezvous') return [ap.settled ? 'AUTOPILOT · ALONGSIDE' : 'AUTOPILOT · RENDEZVOUS', 'ftl'];
    if (ap.settled) return [hold ? 'AUTOPILOT · HOLDING' : 'AUTOPILOT · IN ORBIT', 'ftl'];
    return [hold ? 'AUTOPILOT · MOVING TO HOLD' : 'AUTOPILOT · ORBIT INSERTION', 'ftl'];
  }
  if (jump && jump.phase === 'tunnel') return ['HYPERSPACE', 'ftl'];
  if (jump && jump.phase === 'depart') return ['HYPERDRIVE ENGAGED', 'ftl'];
  // charge timers count seconds at full power: show them at the power actually flowing
  const atPower = (t: number, full: number) => (t * full) / Math.max(g.power.chargeKW, 1);
  if (jump) return [`HYPERDRIVE ${atPower(jump.t, SHIP.jumpChargeKW).toFixed(1)}`, 'ftl'];
  if (ship.ftlCharge > 0) return [`FTL CHARGING ${atPower(ship.ftlCharge, SHIP.ftlChargeKW).toFixed(1)}`, 'ftl'];
  if (ship.mode === 'ftl') return ['FTL', 'ftl'];
  if (ship.landed) return ['LANDED', ''];
  return ['NORMAL SPACE', ''];
}

/** Dashboard tell-tales (see Lamp in hud/types.ts). */
function lamps(g: Game): Lamp[] {
  const { ship, power } = g;
  const L = (id: Lamp['id'], on: unknown, name: string, key: string | undefined, detail: string | undefined, state: Lamp['state'] = 'on', blink = false, progress?: number): Lamp => ({
    id, name, key, detail, state: on ? state : 'off', blink: !!on && blink, progress: on && progress !== undefined ? Math.min(1, Math.max(0, progress)) : undefined,
  });
  const charging = g.jump?.phase === 'charge' || ship.ftlCharge > 0;
  const rad = ship.outfit.radiatorsOut;
  const lock = ship.mode === 'normal' && !g.jump ? massLock(g) : null;
  // how far out of the lock: height over the world as a share of the lock's reach (sim/ftl.ts); the
  // ring shows how deep in it you are, full at the surface and emptying as you climb out
  const lockOut = lock ? Math.min(1, Math.max(0, lock.pos.distanceTo(ship.pos) - lock.radius) / (dropAlt(lock) * MASS_LOCK_K)) : 0;
  const chargeDone = g.jump?.phase === 'charge' ? 1 - g.jump.t / JUMP_CHARGE_TIME : ship.ftlCharge > 0 ? 1 - ship.ftlCharge / FTL_CHARGE_TIME : 0;
  const cap = battCap(ship);
  const battLow = ship.batt < cap * 0.1;
  const ap = ship.ap;
  return [
    // flight
    L('fa', ship.fa, 'Flight assist', 'Shift+Z', ship.fa ? 'Damps drift and holds the speed limit' : 'Off: pure Newtonian flight, no speed limit'),
    L('decoupled', ship.decoupled, 'Decoupled', 'V', "Turning doesn't change your course", 'warn'),
    L('autopilot', ap || g.autodock || g.route?.running, 'Autopilot', 'O',
      g.autodock ? `Docking computer · ${g.autodock.phase}` : g.route?.running ? `Nav route · ${g.route.status || 'flying'}` : ap ? apLabel(ap) : 'Idle', 'ftl'),
    L('cruise', ship.mode === 'ftl' && ship.cruise, 'FTL cruise control', 'F', ship.mode === 'ftl' ? `Throttle ${Math.round(ship.throttle * 100)}%` : 'FTL only', 'ftl'),
    L('dock', g.dock, 'Docking', 'K',
      g.dock?.docked ? `Docked at ${g.dock.station.name} · pad ${g.dock.pad + 1}` : g.dock ? `Pad ${g.dock.pad + 1} granted at ${g.dock.station.name}` : g.dockRequest ? 'Request sent · waiting for traffic control' : 'No clearance',
      'on', !g.dock && !!g.dockRequest),
    // ship systems
    L('sun', ship.sunTrack, 'Sun tracking', 'P', `Keeps the solar panels on the star · ${fmtPower(power.solar)}`),
    L('lights', g.lights, 'Headlights', 'Shift+L', g.lights ? `Drawing ${fmtPower(power.lightsKW)}` : undefined),
    L('radiators', rad > 0, 'Radiators', 'Shift+R', rad > 0 ? (rad < 1 ? `Moving · ${Math.round(rad * 100)}% out` : 'Deployed · thrust limited') : radiatorsFitted(ship.outfit).length ? 'Stowed' : 'None fitted', 'on', rad > 0 && rad < 1, rad > 0 && rad < 1 ? rad : undefined),
    L('pump', power.pumpKW > 0, 'Heat pump', undefined, power.pumpKW > 0 ? `Running · ${fmtPower(power.pumpKW)}` : pumpFitted(ship.outfit) ? 'Idle · runs when the hull is hot' : 'None fitted'),
    L('vent', ship.vent, 'Hydrogen vent', 'R', 'Dumps hydrogen through the heat exchanger to cool the hull', 'ftl'),
    L('scoop', ship.scoop, 'Fuel scoop', undefined, ship.scoop || 'Not scooping', 'ftl'),
    L('radar', g.radar.sweep > 0, 'Radar sweep', 'Shift+Y', g.radar.sweep > 0 ? `${g.radar.sweep.toFixed(1)} s left` : 'Idle', 'on', true),
    // the fuel cell (sim/oxygen.ts): lit while it runs, with its output and what it burns
    L('fuelcell', power.fcOn, 'Fuel cell', undefined, power.fcOn ? `${fmtPower(power.fcKW)} from H₂ + O₂ · ${((power.fcKW / FC_KWH) * O2_PER_H2).toFixed(0)} kg O₂/h · stops over ${FC_OFF * 100} % battery` : `Starts when the battery falls under ${FC_ON * 100} %`),
    L('shore', power.shore > 0, 'Shore power', undefined, power.shore > 0 ? `Station supplying ${fmtPower(power.shore)}` : 'Only when docked'),
    // warnings and modes
    L('charge', charging, g.jump ? 'Hyperdrive charging' : 'FTL drive charging', g.jump ? 'H' : 'J', charging ? `${Math.max(0, g.jump?.t ?? ship.ftlCharge).toFixed(1)} s at full power` : undefined, 'ftl', true, charging ? chargeDone : undefined),
    L('entry', g.aero.heatW > 1e6, 'Entry heating', undefined, g.aero.heatW > 1e6 ? `${fmtPower(g.aero.heatW / 1000)} into the hull at ${Math.round(g.aero.speed)} m/s · slow down, nose first` : 'Not in air at speed', 'warn', g.aero.heatW > 1e8),
    L('masslock', lock, 'Mass lock', undefined, lock ? `${lock.name} is too close for FTL · ${Math.round(lockOut * 100)}% of the way out (${fmtDist(dropAlt(lock) * MASS_LOCK_K)} up) · the red LOCK EXIT marker points the way` : 'Clear for FTL', 'warn', false, lock ? 1 - lockOut : undefined),
    L('hot', ship.temp >= TEMP.warn, 'Hull temperature', undefined, `${ship.temp.toFixed(0)} K · warning at ${TEMP.warn} K`, 'warn', ship.temp >= TEMP.drives),
    L('battery', battLow, 'Battery low', undefined, `${fmtEnergy(ship.batt)} of ${fmtEnergy(cap)}`, 'warn', ship.batt < 1),
    L('power', power.limited, 'Power short', undefined, power.limited ? `${power.limited.what} got ${Math.round(power.limited.frac * 100)}% of what it asked for` : 'The bus covers every load', 'warn'),
    L('warp', g.warp > 1, 'Time warp', ', / .', g.warp > 1 ? `×${g.warp.toLocaleString('en-US')}` : 'Real time', 'warn'),
    L('pivot', g.pivot, 'Pivot to target', 'Shift+T / wheel click', g.pivot ? `Turning onto ${g.target?.name ?? g.jumpDest?.name ?? 'the target'}` : 'Turns the nose onto the target'),
    L('zoom', g.zoom.on, 'Periscope', 'Z', g.zoom.on ? `${g.zoom.mag}× zoom` : undefined),
  ];
}

function flight(g: Game): FlightView {
  const { ship, keys, jump } = g;
  const [mode, modeClass] = flightMode(g);
  // in hyperspace too the readout is in multiples of c (the transit speed is kept in ly/s)
  const [speed, speedUnit] = fmtSpeed(jump && jump.phase === 'tunnel' ? transitState(jump).speed * LY : g.curSpeed);
  const ringF = !g.refFrame && ship.mode === 'normal' ? ringFrameOf(g) : null;
  const unit = g.refFrame && ship.mode === 'normal' ? `${speedUnit} · REL. ${g.refFrame.name.toUpperCase()}` : ringF ? `${speedUnit} · REL. RING` : speedUnit;
  // in hyperspace: just the transit, none of the local flight readouts
  if (jump && jump.phase === 'tunnel') {
    const st = transitState(jump);
    return { mode, modeClass, speed, unit, barFrac: st.u, barFtl: true, barLabel: 'TRANSIT', barValue: `${st.left.toFixed(1)} ly to go`, alt: null, orbit: null, pills: [] };
  }
  // accelerating out of the system: the speed readout climbs through the units, km/s to c
  if (jump && jump.phase === 'depart') {
    return { mode, modeClass, speed, unit, barFrac: 1 - jump.t / JUMP_DEPART_TIME, barFtl: true, barLabel: 'DEPARTURE', barValue: `hyperspace in ${Math.max(0, jump.t).toFixed(1)} s`, alt: null, orbit: null, pills: [] };
  }
  let barFrac: number, barLabel: string, barValue: string;
  let barMark: number | undefined, barHi: FlightView['barHi'];
  // t counts seconds at full charging power; at less it takes longer (sim/power.ts)
  const charge =
    jump?.phase === 'charge'
      ? { t: jump.t, of: JUMP_CHARGE_TIME, what: 'HYPERDRIVE', frac: g.power.chargeKW / SHIP.jumpChargeKW }
      : ship.ftlCharge > 0
        ? { t: ship.ftlCharge, of: FTL_CHARGE_TIME, what: 'FTL DRIVE', frac: g.power.chargeKW / SHIP.ftlChargeKW }
        : null;
  const barFtl = ship.mode === 'ftl' || !!charge;
  if (charge) {
    // charging a drive: the bar fills as the charge completes
    barFrac = 1 - Math.max(0, charge.t) / charge.of;
    barLabel = `${charge.what} CHARGING`;
    const f = Math.max(charge.frac, 1e-3);
    barValue = `${Math.max(0, charge.t / f).toFixed(1)} S${f < 0.999 ? ` · ${Math.round(f * 100)} % POWER` : ''}`;
  } else if (ship.mode === 'ftl') {
    barFrac = ship.throttle;
    barLabel = 'THROTTLE';
    barValue = Math.round(ship.throttle * 100) + '%';
  } else {
    // One bar for normal space, 0 to the boost limit, with a tick at the normal limit. Flight assist
    // won't thrust you past the limit (NORMAL_MAX, or NORMAL_BOOST while Shift is held) and bleeds
    // speed back to it after a boost; with flight assist off there's no limit, only propellant.
    const boost = !!(keys.ShiftLeft || keys.ShiftRight);
    // near a surface flight assist's limit tightens with height (sim/flight.ts surfaceLimit): the
    // bar then spans 0 to the boosted limit, with the tick at the limit
    const surf = ship.fa ? surfaceLimit(g) : null;
    // in a ring's belt, a lower limit among the rocks (sim/flight.ts beltLimit)
    const belt = surf === null ? beltLimit(g) : null;
    const near = surf ?? belt;
    const lim = near ?? NORMAL_MAX,
      top = near !== null ? near * 3 : NORMAL_BOOST;
    barFrac = Math.min(1, g.curSpeed / top);
    barMark = lim / top;
    barLabel = ship.fa ? `${surf !== null ? 'SURFACE ' : belt !== null ? 'BELT ' : ''}LIMIT ${fmtSpeedText(lim).toUpperCase()}` : 'FA OFF · NO LIMIT';
    barValue = `SHIFT BOOST ${fmtSpeedText(top).toUpperCase()}`;
    barHi = !ship.fa ? undefined : boost ? 'right' : 'left';
  }

  // altitude, vertical speed and orbit, relative to the body pulling on you (skipped far out in a star's pull)
  const gr = ship.grav,
    ap = ship.ap;
  let alt: Readout | null = null,
    orbit: Readout | null = null;
  if (gr && ship.mode === 'normal' && !ship.dead && (gr.body.kind !== 'star' || gr.g >= 0.02)) {
    const b = gr.body;
    const oe = orbitElements(ship, b);
    const h = oe.r - surfaceRadius(b, ship.pos); // above the ground under you (sim/terrain.ts)
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

  // on/off states are dashboard lamps (lamps()); pills carry the ones with a value
  const pills: Pill[] = [];
  if (g.autodock) pills.push({ text: `AUTO-DOCK · ${g.autodock.phase.toUpperCase()}`, kind: 'ftl' });
  if (g.ascent) pills.push({ text: 'ASCENT PROGRAM', kind: 'ftl' });
  if (g.pivot) pills.push({ text: g.pivotLocked ? `LOCKED · ${(g.target?.name ?? g.jumpDest?.name ?? '').toUpperCase()}` : 'PIVOTING', kind: 'on' });
  const lz = g.laser;
  if (lz.on) pills.push({ text: lz.rate > 0 ? `LASER · +${lz.rate.toFixed(0)} kg/s${lz.metal > 0.05 ? ` · METAL +${lz.metal.toFixed(1)} kg/s` : ''}` : `LASER · ${lz.hit ? lz.why || 'no yield' : lz.why || 'firing'}`.toUpperCase(), kind: lz.rate > 0 ? 'on' : 'warn' });
  const th = g.rockThreat;
  if (th) pills.push({ text: `ROCK ${rockLabel(th.size)} · ${Math.max(0, threatNow(g, th).t).toFixed(1)} s${th.avoiding ? ' · AVOIDING' : ''}`, kind: 'warn' });
  if (g.dock) pills.push({ text: g.dock.docked ? `DOCKED · PAD ${g.dock.pad + 1}` : `PAD ${g.dock.pad + 1} GRANTED`, kind: g.dock.docked ? 'on' : 'ftl' });
  if (g.zoom.on) pills.push({ text: `ZOOM ${g.zoom.mag}×`, kind: 'on' });
  if (g.warp > 1) pills.push({ text: `TIME ×${g.warp.toLocaleString('en-US')}`, kind: 'warn' });
  if (ship.mode === 'ftl' && !ship.cruise) pills.push({ text: 'HOLD W', kind: '' });
  if (gr && ship.mode === 'normal' && !ship.dead) {
    const gs = gr.g / 9.80665;
    pills.push({ text: `${gs < 0.01 ? gs.toExponential(1) : gs.toFixed(gs < 1 ? 2 : 1)} g`, kind: gr.g > NORMAL_ACC ? 'warn' : '' });
  }
  return { mode, modeClass, speed, unit, barFrac, barFtl, barLabel, barValue, barMark, barHi, alt, orbit, pills };
}

function target(g: Game): TargetView {
  const { ship } = g;
  const t = g.target;
  if (!t) return { name: 'NO TARGET', type: 'T · G · CLICK', distance: '—', eta: '', none: true, scan: null, scanFrac: 0, approach: null };
  const sp = scanProgress(g, t);
  let scan: Readout | null = null;
  if (g.scanning === t) scan = { text: `SCANNING · ${Math.floor(sp * 100)} %` };
  else if (sp < 1) {
    const r = resolvable(g, t);
    scan = !g.ship.avionics.scanner ? { text: 'UNSCANNED · NO SCANNER' } : r.ok ? { text: sp > 0 ? `${Math.floor(sp * 100)} % SCANNED · Y` : 'UNSCANNED · Y TO SCAN' } : { text: `OUT OF RESOLUTION · ${fmtDist(r.needDist)}`, warn: true };
  }
  const d = t.kind === 'station' ? t.pos.distanceTo(ship.pos) - t.size / 2 : t.kind === 'ship' ? t.pos.distanceTo(ship.pos) : surfaceDist(t, ship.pos); // to the ground under you up close
  const dir = tmp.subVectors(t.pos, ship.pos).normalize();
  const vel = ship.mode === 'ftl' ? ship.travelDir.clone().multiplyScalar(ship.ftlSpeed) : ship.vel.clone();
  vel.add(g.frameBody.vel).sub(t.vel); // everything moves, so close on the target in its own frame
  const closing = vel.dot(dir);
  const type = sp < SCAN_STAGE.type ? (t.kind === 'ship' ? 'SHIP' : 'UNKNOWN') : t.kind === 'station' ? stationKind(t) : t.kind === 'ship' ? t.cls.toUpperCase() : t.typeName.toUpperCase();
  // (on a sky station's open deck you're never "inside" it, but docked is docked)
  const inside = g.inStation === t || (!!g.dock?.docked && g.dock.station === t);
  return { name: contactLabel(g, t), type, distance: inside ? (g.dock?.docked ? 'DOCKED' : 'INSIDE') : fmtDist(d), eta: closing > 1 ? `ETA ${fmtTime(d / closing)}` : 'NOT CLOSING', none: false, scan, scanFrac: sp, approach: inside ? null : approachView(g, t, d, closing) };
}

function systems(g: Game): SystemsView {
  const { ship, power } = g;
  const refLy = g.jumpDest ? g.jumpDest.pos.distanceTo(galPos(g)) : 15;
  const net = power.net;
  const netText = `${net >= 0 ? '+' : '−'}${fmtPower(Math.abs(net))}`;
  const cap = battCap(ship);
  const battTime = net < -0.5 ? ` · empty in ${fmtTime((ship.batt / -net) * 3600)}` : net > 0.5 && ship.batt < cap - 0.05 ? ` · full in ${fmtTime(((cap - ship.batt) / net) * 3600)}` : '';
  const ftlRate = ship.mode === 'ftl' ? ftlBurn(ship.ap ? 1 : ship.throttle) : 0;
  let note: Readout | null = null;
  if (ship.tanker) note = { text: `Tanker arriving in ${Math.ceil(ship.tanker.t)} s · hold still` };
  else if (ship.scoop) note = { text: ship.scoop };
  if (ship.temp >= TEMP.panels && !ship.tanker) note = { text: `Solar panels feathered · hull over ${TEMP.panels} K${ship.scoop ? ` · ${ship.scoop[0].toLowerCase()}${ship.scoop.slice(1)}` : ''}`, warn: true };
  else if (ship.prop <= 0) note = { text: 'No propellant · Shift+K for a tanker, or skim a gas giant or star', warn: true };
  else if (ship.batt <= 0) note = { text: 'Battery flat · P turns the panels to the star', warn: true };
  else if (power.shadow) note = { text: `In ${power.shadow.name}'s shadow · no solar power` };
  if (power.limited && !note?.warn) note = { text: `Power-limited · ${power.limited.what} at ${Math.round(power.limited.frac * 100)} % (bus ${fmtPower(power.cap)})`, warn: true };
  const sr = ship.scoopRate;
  const burnLow = ship.burnRate > 1 && ship.prop / Math.max(ship.burnRate, 1e-9) < 300;
  return {
    gauges: [
      {
        label: 'H₂',
        icon: 'prop',
        value: fmtMass(ship.prop),
        frac: ship.prop / SHIP.propCap,
        sub: {
          text: sr.prop > 0 ? `scooping +${fmtFlow(sr.prop)} · full in ${fmtTime((SHIP.propCap - ship.prop) / sr.prop)}` : ship.burnRate > 0.01 ? `Δv ${fmtSpeedText(deltaVLeft(ship))} · burning ${fmtFlow(ship.burnRate)}` : `Δv ${fmtSpeedText(deltaVLeft(ship))} left`,
          warn: burnLow,
        },
      },
      {
        label: 'EXOTIC',
        icon: 'exotic',
        value: fmtMass(ship.exotic),
        frac: ship.exotic / SHIP.exoticCap,
        variant: 'ftl',
        sub: {
          text: sr.exotic > 0 ? `scooping +${sr.exotic.toFixed(2)} kg/s · full in ${fmtTime((SHIP.exoticCap - ship.exotic) / sr.exotic)}` : ship.mode === 'ftl' ? `burning ${fmtFlow(ftlRate)} · ${fmtTime(ship.exotic / ftlRate)} left` : `${Math.floor(ship.exotic / jumpCost(refLy))} jumps of ${refLy.toFixed(0)} ly`,
        },
      },
      {
        label: 'BATTERY',
        value: fmtEnergy(ship.batt),
        frac: ship.batt / cap,
        variant: 'batt',
        sub: { text: `${g.power.fcKW > 0.5 ? `fuel cell +${fmtPower(g.power.fcKW)} · ` : ''}${netText}${battTime}`, warn: net < -0.5 },
        badges: ship.temp >= TEMP.panels ? [{ icon: 'panels-off', title: `Solar panels feathered: hull over ${TEMP.panels} K`, warn: true }] : undefined,
      },
      o2Gauge(g),
      hullGauge(g),
      integrityGauge(g),
      cargoGauge(g),
    ],
    note,
  };
}

/**
 * Oxygen (sim/oxygen.ts): the LOX tank, and what's happening to it: coming in (split from water,
 * scooped from air), the fuel cell burning it, or how long life support can breathe it.
 */
function o2Gauge(g: Game): GaugeView {
  const { ship, power } = g;
  const fcO2 = (power.fcKW / FC_KWH) * O2_PER_H2; // kg/h
  const days = o2Days(ship.o2);
  const boiling = ship.boil.o2 + ship.boil.prop > 0;
  const text = boiling
    ? `cryocoolers off · boiling off ${((ship.boil.prop + ship.boil.o2) * 86400).toFixed(0)} kg/day of LH₂ + LOX`
    : ship.o2Rate > 1e-4
      ? `+${ship.o2Rate * 3600 < 100 ? (ship.o2Rate * 3600).toFixed(1) : Math.round(ship.o2Rate * 3600)} kg/h ${power.electrolysisKW > 0.5 ? `split from water (${fmtPower(power.electrolysisKW)})` : 'from the air'}`
      : power.fcKW > 0.5
        ? `fuel cell burning ${fcO2.toFixed(0)} kg/h · ${fmtTime((ship.o2 / fcO2) * 3600)} left`
        : g.dock?.docked
          ? "breathing the station's air"
          : `life support · ${days > 60 ? `${Math.round(days)} days` : fmtTime(days * 86400)} of breathing`;
  return { label: 'O₂', icon: 'o2', value: fmtMass(ship.o2), frac: ship.o2 / SHIP.o2Cap, variant: 'o2', sub: { text, warn: days < 3 || boiling } };
}

/**
 * Hull temperature: the bar runs from 200 K to the failure point. The line under it says where it's
 * heading: the time to the next limit if it will get there, otherwise where it settles.
 */
function hullGauge(g: Game): GaugeView {
  const T = g.ship.temp,
    h = g.heat;
  // (with the vent running, the equilibrium ignores it: say where it's heading while it runs)
  let text = 'steady';
  if (h) {
    const next = nextLimit(T);
    const perMin = h.rate * 60;
    const trend = Math.abs(perMin) < 0.05 ? 'steady' : `${perMin > 0 ? '+' : '−'}${Math.abs(perMin).toFixed(Math.abs(perMin) < 10 ? 1 : 0)} K/min`;
    text =
      next && h.rate > 0 && h.eq >= next.at ? `${trend} · ${next.what} (${next.at} K) in ${fmtTime((next.at - T) / h.rate)}` : `${trend} · settles at ${h.eq.toFixed(0)} K`;
  }
  const o = g.ship.outfit;
  const badges: GaugeBadge[] = [];
  if (h && h.ventFlow > 0) {
    badges.push({ icon: 'vent', title: `Venting hydrogen: ${h.ventFlow.toFixed(1)} kg/s` });
    text = `venting ${h.ventFlow.toFixed(1)} kg/s H₂ · ${text}`;
  }
  if (o.radiatorsOut > 0) badges.push({ icon: 'radiators', title: o.radiatorsOut < 1 ? `Radiators ${o.deploy ? 'deploying' : 'stowing'} (${Math.round(o.radiatorsOut * 100)} %)` : 'Radiators out' });
  if (h && h.pumpW > 0) badges.push({ icon: 'pump', title: `Heat pump: ${fmtPower(h.pumpW / 1000)}, loop at ${h.radTemp.toFixed(0)} K` });
  return { label: 'HULL', value: `${T.toFixed(0)} K`, frac: (T - 200) / (TEMP.fail - 200), variant: 'heat', sub: { text, warn: T >= TEMP.warn }, badges };
}

/** The hold (sim/economy.ts), and your credits under it. */
function cargoGauge(g: Game): GaugeView {
  const kg = cargoMass(g);
  const c = g.ship.cargo;
  const what = kg > 0.5 ? ` · ${(Object.keys(COMMODITIES) as Commodity[]).filter((k) => (c[k] ?? 0) > 0.5).map((k) => `${COMMODITIES[k].name.toLowerCase()} ${fmtMass(c[k]!)}`).join(', ')}` : '';
  return { label: 'CARGO', icon: 'cargo', value: `${fmtMass(kg)} / ${fmtMass(CARGO_CAP)}`, frac: kg / CARGO_CAP, sub: { text: `${fmtCr(g.credits)}${what}` } };
}

/** The station window's Trading tab: each metal, what you hold, this station's price against the list price, and what it fetches. */
function tradeRows(g: Game, st: Station) {
  return (Object.keys(COMMODITIES) as Commodity[]).map((id) => {
    const kg = g.ship.cargo[id] ?? 0,
      p = sellPrice(st, id),
      f = p / COMMODITIES[id].price - 1;
    return {
      id,
      name: COMMODITIES[id].name,
      have: kg > 0.5 ? fmtMass(kg) : '—',
      price: `${p < 1 ? p.toFixed(3) : p.toFixed(2)} Cr/kg`,
      vs: { text: `${f >= 0 ? '+' : '−'}${Math.round(Math.abs(f) * 100)} % on list`, up: f >= 0 },
      value: fmtCr(kg * p),
      empty: kg < 0.5,
    };
  });
}

/** The contracts window (Shift+J): the board at the station you're docked at, and your jobs. */
function contractsView(g: Game): ContractsView {
  const st = g.dock?.docked ? g.dock.station : null;
  const kg = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(1)} t` : `${Math.round(x)} kg`);
  const job = (c: Contract, mine: boolean): JobView => {
    const left = mine ? c.deadline - g.simTime : c.allow;
    const elsewhere = c.to.sys !== g.cur.sys.id;
    const title = c.kind === 'haul' ? `Haul ${kg(c.kg)} of ${c.what}` : c.kind === 'courier' ? `Courier · ${c.what}` : `Wanted · ${kg(c.kg)} of ${c.what}`;
    const route = c.kind === 'metal' ? `to ${c.to.station}${elsewhere ? `, ${c.to.sysName}` : ''}` : `to ${c.to.station}${elsewhere ? `, ${c.to.sysName}` : ''} · ${reach(g, c)}`;
    const have = c.kind === 'metal' ? g.ship.cargo[c.commodity!] ?? 0 : 0;
    return {
      id: c.id,
      kind: c.kind,
      title,
      route,
      client: c.client,
      reward: fmtCr(c.reward),
      // yours: the live countdown; on the board: the time you'd get once you take it (not a clock:
      // shown as a countdown it looked stuck)
      time: { text: mine ? `${fmtTime(Math.max(0, left))} left` : `${Math.round(left / 60)} min to deliver once taken`, warn: mine && left < 300 },
      note: mine ? (c.kind === 'metal' ? `${kg(Math.min(have, c.kg))} of ${kg(c.kg)} in the hold` : null) : cantTake(g, c),
      canDeliver: mine && canDeliverMetal(g, c),
      progress: mine && c.kind === 'metal' ? Math.min(1, have / c.kg) : null,
      canPlot: mine && !(st && st.name === c.to.station && !elsewhere),
      armed: g.abandonArm?.id === c.id,
    };
  };
  return {
    station: st?.name ?? null,
    board: st ? board(g, st).map((c) => job(c, false)) : [],
    mine: g.contracts.map((c) => job(c, true)),
    max: MAX_ACTIVE,
    credits: fmtCr(g.credits),
    refresh: fmtTime(BOARD_S - (g.simTime % BOARD_S)),
  };
}

/**
 * The cargo window (Shift+I): each metal in the hold with its value (at the docked station's
 * prices, else list), the tanks, and what the load costs in Δv.
 */
function cargoView(g: Game): CargoView {
  const { ship } = g;
  const st = g.dock?.docked ? g.dock.station : null;
  const kg = cargoMass(g);
  const items = (Object.keys(COMMODITIES) as Commodity[]).map((id) => {
    const m = ship.cargo[id] ?? 0,
      p = sellPrice(st, id);
    return { id, name: COMMODITIES[id].name, mass: fmtMass(m), frac: m / CARGO_CAP, price: `${p < 1 ? p.toFixed(3) : p.toFixed(2)} Cr/kg`, value: fmtCr(m * p), empty: m < 0.5 };
  });
  // Δv with this load, and what it would be with an empty hold (the hold counts in the dry mass)
  const dv = deltaVLeft(ship),
    dry = dryMass(ship),
    dv0 = SHIP.ve * Math.log((dry - kg + ship.prop) / (dry - kg));
  const lz = g.laser;
  return {
    used: `${fmtMass(kg)} / ${fmtMass(CARGO_CAP)}`,
    frac: kg / CARGO_CAP,
    items,
    total: fmtCr(cargoValue(g, st)),
    where: st ? `at ${st.name}` : 'at list prices',
    credits: fmtCr(g.credits),
    tanks: [
      { name: 'Hydrogen', value: `${fmtMass(ship.prop)} / ${fmtMass(SHIP.propCap)}`, frac: ship.prop / SHIP.propCap, kind: 'prop' },
      { name: 'Exotic matter', value: `${fmtMass(ship.exotic)} / ${fmtMass(SHIP.exoticCap)}`, frac: ship.exotic / SHIP.exoticCap, kind: 'exotic' },
      { name: 'Oxygen', value: `${fmtMass(ship.o2)} / ${fmtMass(SHIP.o2Cap)}`, frac: ship.o2 / SHIP.o2Cap, kind: 'o2' },
      { name: 'Water (to split)', value: `${fmtMass(ship.water)} / ${fmtMass(SHIP.waterCap)}`, frac: ship.water / SHIP.waterCap, kind: 'water' },
    ],
    mass: fmtMass(dry + ship.prop),
    dv: kg > 0.5 ? `${fmtSpeedText(dv)} · ${fmtSpeedText(dv0 - dv)} less than empty` : fmtSpeedText(dv),
    mining: lz.on && lz.metal > 0.01 ? `Laser catching ${lz.metal.toFixed(1)} kg/s of metal` : null,
    docked: !!st,
    crates: g.contracts.filter((c) => c.kind === 'haul' && g.ship.crates[c.id]).map((c) => ({ what: c.what, mass: fmtMass(g.ship.crates[c.id]), to: c.to.station })),
    armed: g.jettisonArm?.c ?? null,
  };
}

/** Structural integrity (sim/damage.ts): the bar, and what's wearing it or how to mend it. */
function integrityGauge(g: Game): GaugeView {
  const h = g.ship.hull;
  const heat = heatDamageRate(g.ship.temp);
  const text = heat > 0 ? `weakening ${(heat * 6000).toFixed(0)} %/min from heat` : g.erosion > 1e-6 ? `ring dust wearing it ${(g.erosion * 6000).toFixed(g.erosion < 1e-3 ? 2 : 1)} %/min` : h >= 0.999 ? 'sound' : g.dock?.docked ? 'repair: station window, Services' : 'dock at a station to repair';
  return { label: 'INTEGRITY', value: `${Math.round(h * 100)} %`, frac: h, sub: { text, warn: heat > 0 || g.erosion > 1e-6 || h <= HULL_WARN } };
}

function autopilotView(g: Game): AutopilotView {
  const { ship } = g;
  const ap = ship.ap!;
  const b = ap.body,
    R = b.radius;
  const label = { equatorial: 'Equatorial orbit', polar: 'Polar orbit', sync: 'Stationary orbit', hold: 'Hold position', ring: 'Ring orbit', rendezvous: 'Rendezvous' }[ap.type];
  const [mode] = flightMode(g);
  const rv = ship.pos.clone().sub(b.pos);
  const v = velRel(g, b);
  const used = Math.max(0, ap.prop0 - ship.prop);
  const dv = SHIP.ve * Math.log((dryMass(ship) + ap.prop0) / (dryMass(ship) + ship.prop));
  const rows: [string, string | Readout][] = [];
  if (ap.type === 'rendezvous') {
    const st = ap.station!;
    rows.push(['STATION', st.name]);
    rows.push(['DISTANCE', fmtDist(st.pos.distanceTo(ship.pos))]);
    rows.push(['RELATIVE SPEED', fmtSpeedText(v.distanceTo(st.vel.clone().sub(b.vel)))]);
  } else if (ap.type === 'hold') {
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
    // live deviation readouts are an HX-9100 feature
    if (ship.avionics.orbit?.caps.readouts) rows.push(['ALTITUDE OFF', { text: `${dAlt >= 0 ? '+' : '−'}${fmtDist(Math.abs(dAlt))}`, warn: big(Math.abs(dAlt), Math.max(2000, ap.r0 * 0.004)) }]);
    if (ship.avionics.orbit?.caps.readouts) {
      rows.push(['PLANE OFF', { text: fmtDist(dPlane), warn: big(dPlane, 5000) }]);
      rows.push(['SPEED OFF', { text: fmtSpeedText(dVel), warn: big(dVel, 20) }]);
    }
  }
  rows.push(['ENGAGED', `${fmtTime(g.simTime - ap.t0)} · Δv ${fmtSpeedText(dv)} · ${fmtMass(used)} H₂`]);
  return {
    unit: ship.avionics.orbit ? unitLabel(ship.avionics.orbit).toUpperCase() : 'AUTOPILOT',
    title: label,
    sub: ap.type === 'rendezvous' ? `${ap.station!.name} · around ${b.name}` : `${b.name} · ${ap.type === 'hold' ? fmtDist(ap.r0 - R) + ' up' : fmtDist(ap.r0 - R) + ' · ' + fmtTime(ap.period)}`,
    state: { text: mode.replace('AUTOPILOT · ', ''), warn: false },
    rows,
    confirm: g.apConfirm > 0,
  };
}

const fmtArcsec = (rad: number) => `${((rad * 180 * 3600) / Math.PI).toFixed(rad < 1e-5 ? 1 : 0)}″`;

/**
 * Avionics (U): a table of contents for the ship's computers. Each entry: its key, unit, what it's
 * for, what it's doing now, and its specs; clicking it (or its key) opens its tool.
 */
/**
 * Radar window (Shift+Y). The scope is the ship's view from above, nose up: each contact at its
 * bearing, at a log-scaled distance (1,000 km at the centre to RADAR_RANGE at the rim).
 */
function radarView(g: Game): RadarView {
  const r = g.radar;
  const lo = Math.log10(1e6),
    hi = Math.log10(RADAR_RANGE);
  const scale = (d: number) => Math.min(1, Math.max(0, (Math.log10(Math.max(d, 1e6)) - lo) / (hi - lo)));
  const v = new THREE.Vector3();
  return {
    sweeping: r.sweep > 0 ? 1 - r.sweep / SWEEP : 0,
    range: `${RADAR_RANGE / AU} AU`,
    power: r.sweep > 0 ? fmtPower(g.power.radarKW) : 'idle',
    rings: [
      { r: scale(1e7), label: '10,000 km' },
      { r: scale(1e9), label: '1 million km' },
      { r: scale(AU), label: '1 AU' },
      { r: 1, label: `${RADAR_RANGE / AU} AU` },
    ],
    contacts: radarContacts(g).map((c) => {
      v.subVectors(c.target.pos, g.ship.pos).applyQuaternion(g.qInv);
      const h = Math.hypot(v.x, v.z) || 1;
      const k = scale(v.length()) / h;
      const p = scanProgress(g, c.target);
      return {
        key: c.key,
        label: contactLabel(g, c.target),
        cls: radarClass(c.target),
        dist: fmtDist(c.dist),
        x: v.x * k,
        y: v.z * k, // forward (−z) is up on the scope
        above: v.y >= 0,
        scanned: p >= SCAN_STAGE.type,
        scanning: g.scanning === c.target,
        targeted: g.target === c.target,
      };
    }),
    prospects: liveProspects(g).map((p, i) => {
      const now = prospectNow(g, p).add(g.frameBody.pos);
      return { n: i + 1, kind: p.kind, size: rockLabel(p.size), dist: fmtDist(Math.max(0, now.distanceTo(g.ship.pos) - p.size)), worth: `${fmtCr(p.perHour)}/h mining · metal ${p.perKg.toFixed(2)} Cr/kg${p.metalKg < CARGO_CAP ? ` · ${fmtMass(p.metalKg)} in it` : ''}` };
    }),
  };
}

/** Outfit panel (Shift+U): slots, thermal hardware, and the station catalogue when alongside one. */
function outfitView(g: Game): OutfitView {
  const { ship } = g;
  const o = ship.outfit;
  const st = outfitter(g);
  const specsOf = (m: Module) =>
    m.kind === 'radiator'
      ? `${fmtArea(2 * m.caps.area)} radiating · ${m.caps.deployTime} s to deploy · ${fmtMass(m.mass)}`
      : m.kind === 'heatpump'
        ? `lift ${m.caps.lift} K · up to ${fmtPower(m.caps.maxKW)} · ${fmtMass(m.mass)}`
        : m.kind === 'deflector'
          ? `stops ${Math.round(m.caps.block * 100)} % of dust erosion · ${fmtPower(m.caps.kw)} while working · ${fmtMass(m.mass)}`
          : m.kind === 'laser'
            ? `${fmtPower(m.caps.kw)} beam · out to ${fmtDist(m.caps.range)} · ${fmtMass(m.mass)}`
            : m.kind === 'fuelcell'
            ? `${fmtPower(m.caps.kw)} · ${((m.caps.kw / FC_KWH)).toFixed(1)} kg H₂ + ${((m.caps.kw / FC_KWH) * O2_PER_H2).toFixed(0)} kg O₂ an hour at full output · ${fmtMass(m.mass)}`
            : m.kind === 'guard'
            ? `rocks ${m.caps.minSize} m and up · ${fmtDist(m.caps.range)} ahead · ${m.caps.avoid ? 'steers clear' : 'warns'} · ${fmtPower(m.caps.kw)} · ${fmtMass(m.mass)}`
            : `${m.caps.exotic ? 'H₂ + exotic' : 'H₂ only'} · ${m.caps.rate}× intake · ${fmtMass(m.mass)}`;
  const h = g.heat;
  const rads = radiatorsFitted(o);
  const pump = pumpFitted(o);
  const bSpecs = (b: BatteryModule) => `${fmtEnergy(b.caps.capacity)} · ${fmtPower(b.caps.maxKW)} out (${b.caps.maxKW / b.caps.capacity}C) · ${fmtPower(b.caps.chargeKW)} in · ${fmtMass(b.mass)}`;
  return {
    station: st?.name ?? null,
    battery: {
      id: o.battery.id,
      unit: moduleLabel(o.battery),
      maker: o.battery.maker,
      blurb: o.battery.blurb,
      specs: bSpecs(o.battery),
      options: st ? BATTERIES.map((b) => ({ id: b.id, unit: moduleLabel(b), kind: 'BATTERY', icon: 'battery' as const, maker: b.maker, blurb: b.blurb, specs: bSpecs(b), price: fmtCr(fitPrice(st, b.price)), current: b === o.battery })) : [],
    },
    hint: 'Modules are fitted while docked at a station (target one, K for a pad, land on it)',
    slots: o.slots.map((m) =>
      m
        ? { id: m.id, unit: moduleLabel(m), maker: m.maker, blurb: m.blurb, specs: specsOf(m), empty: false, icon: m.kind }
        : { id: null, unit: 'empty', maker: '', blurb: '', specs: '', empty: true, icon: 'empty' as const },
    ),
    catalogue: st
      ? MODULES.map((m) => ({
          id: m.id,
          unit: moduleLabel(m),
          kind: { radiator: 'RADIATORS', heatpump: 'HEAT PUMP', scoop: 'FUEL SCOOP', deflector: 'DEFLECTOR', guard: 'COLLISION RADAR', laser: 'MINING LASER', fuelcell: 'FUEL CELL' }[m.kind],
          icon: m.kind,
          maker: m.maker,
          blurb: m.blurb,
          specs: specsOf(m),
          price: fmtCr(fitPrice(st, m.price)),
          current: false,
        }))
      : [],
    radiators: {
      fitted: rads.length > 0,
      out: o.radiatorsOut,
      deploying: o.deploy,
      status: !rads.length
        ? 'none fitted'
        : o.radiatorsOut === 0
          ? 'stowed · Shift+R deploys'
          : o.radiatorsOut < 1
            ? `${o.deploy ? 'deploying' : 'stowing'} · ${Math.round(o.radiatorsOut * 100)} %`
            : `out · shedding ${fmtPower((h?.radiators ?? 0) / 1000)} · thrust limited to ${(RADIATOR_MAX_ACC / 9.81).toFixed(0)} g`,
    },
    pump: {
      fitted: !!pump,
      auto: o.pumpAuto,
      status: !pump
        ? 'none fitted'
        : !o.pumpAuto
          ? 'off'
          : h && h.pumpW > 0
            ? `running · ${fmtPower(h.pumpW / 1000)} · loop at ${h.radTemp.toFixed(0)} K`
            : o.radiatorsOut > 0
              ? `standing by · runs above ${PUMP_ON_ABOVE} K`
              : 'standing by · needs the radiators out',
    },
    mass: fmtMass(outfitMass(o)),
  };
}

/**
 * Ship stats (U), electrical section: sources (panels, battery) feeding the bus, and every load it
 * serves, as granted this frame (sim/power.ts). The panel draws it as a schematic.
 */
function electricalView(g: Game): ElectricalView {
  const { ship, power } = g;
  const b = ship.outfit.battery;
  const cap = b.caps.capacity;
  const lim = power.limited;
  const limitOf = (id: string) => {
    if (!lim) return null;
    const is = { charge: /charging/, thrust: /thrusters/, ftl: /FTL drive/, pump: /heat pump/, radar: /^radar/, shield: /deflector/, guard: /collision radar/, laser: /mining laser/, electrolysis: /electrolyser/, cryo: /cryocoolers/ }[id];
    return is?.test(lim.what) ? lim.frac : null;
  };
  const net = power.net;
  const t = net < -0.5 ? `empty in ${fmtTime((ship.batt / -net) * 3600)}` : net > 0.5 && ship.batt < cap - 0.05 ? `full in ${fmtTime(((cap - ship.batt) / net) * 3600)}` : 'holding';
  const spare = Math.max(1, Math.min(SHIP.jumpChargeKW, power.cap - SHIP.baseLoad));
  const ftlS = (SHIP.ftlChargeKW * FTL_CHARGE_TIME) / Math.min(SHIP.ftlChargeKW, spare);
  const jumpS = (SHIP.jumpChargeKW * JUMP_CHARGE_TIME) / spare;
  const rows: [string, string | Readout][] = [
    ['BATTERY', { text: `${net >= 0 ? '+' : '−'}${fmtPower(Math.abs(net))} · ${t}`, warn: net < -0.5 }],
    ['CHARGE TIMES', `FTL ${fmtTime(ftlS)} · hyperjump ${fmtTime(jumpS)} at this bus`],
  ];
  if (lim) rows.push(['LIMITED', { text: `${lim.what} at ${Math.round(lim.frac * 100)} % of what it asks`, warn: true }]);
  return {
    solar: {
      kw: power.solar,
      max: SHIP.solarMax,
      state: g.inStation ? 'inside' : power.shadow ? 'shadow' : ship.temp >= TEMP.panels ? 'feathered' : power.solar < 1 ? 'dark' : 'ok',
      curtailed: power.curtailed,
    },
    shore: { kw: power.shore, source: g.dock?.docked ? g.dock.station.name : null },
    fuelcell: (() => {
      const fc = fuelCellFitted(ship.outfit);
      if (!fc) return null;
      const h2 = (power.fcKW / FC_KWH);
      return { unit: moduleLabel(fc), kw: power.fcKW, max: fc.caps.kw, on: loadOn(g, 'fuelcell'), running: power.fcOn, h2, o2: h2 * O2_PER_H2 };
    })(),
    battery: { unit: moduleLabel(b), kwh: ship.batt, cap, flowKW: net, maxKW: b.caps.maxKW, chargeKW: b.caps.chargeKW },
    bus: { capKW: power.cap, drawKW: power.draw },
    loads: [
      { id: 'base', name: 'LIFE SUPPORT · AVIONICS', kw: SHIP.baseLoad, limited: null, sw: null, on: true },
      { id: 'lights', name: 'HEADLIGHTS', kw: power.lightsKW, limited: null, sw: 'lights', on: loadOn(g, 'lights') },
      { id: 'thrust', name: 'THRUSTERS', kw: power.thrustKW, limited: limitOf('thrust'), sw: 'thrust', on: loadOn(g, 'thrust') },
      { id: 'ftl', name: 'FTL DRIVE', kw: power.ftlKW, limited: limitOf('ftl'), sw: 'ftl', on: loadOn(g, 'ftl') },
      { id: 'charge', name: g.jump?.phase === 'charge' ? 'HYPERDRIVE CHARGING' : 'DRIVE CHARGING', kw: power.chargeKW, limited: limitOf('charge'), sw: 'charge', on: loadOn(g, 'charge') },
      { id: 'pump', name: 'HEAT PUMP', kw: power.pumpKW, limited: limitOf('pump'), sw: pumpFitted(ship.outfit) ? 'pump' : null, on: loadOn(g, 'pump') },
      { id: 'radar', name: 'RADAR', kw: power.radarKW, limited: limitOf('radar'), sw: 'radar', on: loadOn(g, 'radar') },
      { id: 'shield', name: 'DEFLECTOR', kw: power.shieldKW, limited: limitOf('shield'), sw: deflectorFitted(ship.outfit) ? 'shield' : null, on: loadOn(g, 'shield') },
      { id: 'laser', name: 'MINING LASER', kw: power.laserKW, limited: limitOf('laser'), sw: laserFitted(ship.outfit) ? 'laser' : null, on: loadOn(g, 'laser') },
      { id: 'guard', name: 'COLLISION RADAR', kw: power.guardKW, limited: limitOf('guard'), sw: guardFitted(ship.outfit) ? 'guard' : null, on: loadOn(g, 'guard') },
      { id: 'cryo', name: 'CRYOCOOLERS', kw: power.cryoKW, limited: limitOf('cryo'), sw: 'cryo', on: loadOn(g, 'cryo') },
      { id: 'electrolysis', name: 'ELECTROLYSER', kw: power.electrolysisKW, limited: limitOf('electrolysis'), sw: 'electrolysis', on: loadOn(g, 'electrolysis') },
    ],
    rows,
  };
}

function avionicsView(g: Game): AvionicsSlotView[] {
  const { ship } = g;
  const { orbit, scanner, nav } = ship.avionics;
  const dockUnit = ship.avionics.dock;
  const o = ship.outfit;
  const list = (...xs: (string | false)[]) => xs.filter(Boolean).join(' · ') || '—';
  const base = (c: Computer | null) => (c ? { unit: unitLabel(c), model: c.model, maker: c.maker, blurb: c.blurb } : { unit: 'none fitted', model: 'none', maker: '', blurb: '' });

  // orbit computer: flying / planning / idle
  const ap = ship.ap;
  const orbitStatus: Readout = ap
    ? { text: `${ap.settled ? 'holding' : 'flying'} · ${apLabel(ap)}${ap.type === 'rendezvous' ? '' : ' around ' + ap.body.name}` }
    : g.planner
      ? { text: `planning · ${g.planner.body.name}` }
      : { text: 'idle' };

  // scanner: the current target's scan state
  const t = g.target;
  let scanStatus: Readout = { text: 'no target' };
  if (g.scanning) scanStatus = { text: `scanning ${g.scanning.name} · ${Math.floor(scanProgress(g, g.scanning) * 100)} %` };
  else if (t && scanner) {
    const p = scanProgress(g, t);
    const r = resolvable(g, t);
    scanStatus = p >= 1 ? { text: `${t.name} scanned` } : r.ok ? { text: `${t.name} ${p > 0 ? Math.floor(p * 100) + ' % scanned' : 'unscanned'} · ready` } : { text: `${t.name} out of resolution`, warn: true };
  }

  // navigation: route state
  const r = g.route;
  const jumps = r?.legs.filter((l) => l.kind === 'jump').length ?? 0;
  const navStatus: Readout = r?.running
    ? { text: `flying route · leg ${r.i + 1} / ${r.legs.length} · ${r.destName.split(' · ')[0]}` }
    : r
      ? { text: `route ready · ${r.destName.split(' · ')[0]}${jumps ? ` · ${jumps} jumps` : ''}` }
      : { text: 'no route' };

  return [
    {
      id: 'orbit', key: 'O', kind: 'ORBIT', does: 'Plan an orbit and let the autopilot fly it', ...base(orbit), status: orbitStatus, active: !!ap,
      specs: orbit ? [
        ['ORBITS', list(...orbit.caps.types.map((x) => ({ equatorial: 'equatorial', polar: 'polar', sync: 'stationary', hold: 'hold', ring: 'ring' })[x]))],
        ['INSERTION', `${orbit.caps.profile.acc} m/s² braking · ${fmtSpeedText(orbit.caps.profile.radialCap)} climb`],
        ['FEATURES', list(orbit.caps.preview && 'preview ring (L)', orbit.caps.ftlLeg && 'FTL leg', orbit.caps.readouts && 'deviation readouts')],
      ] : [],
    },
    {
      id: 'scanner', key: 'Y', kind: 'SCANNER', does: 'Scan the target to reveal what it is', ...base(scanner), status: scanStatus, active: !!g.scanning,
      specs: scanner ? [['RESOLUTION', fmtArcsec(scanner.caps.resolution)], ['SCAN SPEED', `${scanner.caps.rate}×`]] : [],
    },
    {
      id: 'nav', key: 'M', kind: 'NAV', does: 'Plot a route to a star or target and fly it', ...base(nav), status: navStatus, active: !!r?.running,
      specs: nav ? [
        ['ROUTES', nav.caps.crossSystem ? (isFinite(nav.caps.maxHops) ? `up to ${nav.caps.maxHops} jumps` : 'unlimited jumps') : 'in-system only'],
        ['FEATURES', list(nav.caps.refuelStops && 'refuel stops', nav.caps.optimise && 'route modes 1–3')],
      ] : [],
    },
    {
      id: 'dock', key: 'K', kind: 'DOCKING', does: 'Fly in and dock at the targeted station', ...base(dockUnit),
      status: g.autodock ? { text: `flying · ${g.autodock.phase}` } : g.dock?.docked ? { text: `docked · pad ${g.dock.pad + 1}` } : g.dock ? { text: `pad ${g.dock.pad + 1} granted` } : { text: 'standing by' },
      active: !!g.autodock,
      specs: dockUnit
        ? [
            ['SPEEDS', `${dockUnit.caps.approachSpeed} m/s approach · ${dockUnit.caps.insideSpeed} m/s inside`],
            ['FEATURES', list(dockUnit.caps.clearance && `requests clearance (from ${fmtDist(dockUnit.caps.range)})`, dockUnit.caps.launch && 'flies you out after launch')],
          ]
        : [],
    },
    {
      id: 'outfit', key: '⇧U', kind: 'OUTFIT', does: 'Battery and utility modules: fuel scoop, radiators, heat pump', unit: o.slots.filter(Boolean).map((m) => moduleLabel(m!)).join(' · ') || 'no modules fitted', model: `${o.slots.filter(Boolean).length} / ${o.slots.length} slots`, maker: '', blurb: '',
      mods: [{ icon: 'battery', title: `${moduleLabel(o.battery)} battery` }, ...o.slots.map((m) => ({ icon: (m?.kind ?? 'empty') as ModuleIcon, title: m ? moduleLabel(m) : 'empty slot' }))],
      status: { text: outfitter(g) ? `docked at ${outfitter(g)!.name} · can refit` : 'refit when docked' }, active: o.radiatorsOut > 0 || ship.vent,
      specs: [],
    },
  ];
}

function navView(g: Game): NavView {
  const nav = g.ship.avionics.nav;
  const r = g.route;
  const legs = (r?.legs ?? []).map((l, i) => {
    const state: 'done' | 'active' | 'pending' = !r?.running ? 'pending' : i < r.i ? 'done' : i === r.i ? 'active' : 'pending';
    if (l.kind === 'jump') return { text: `Jump → ${l.to.name}`, detail: `${l.ly.toFixed(1)} ly · ${l.cost.toFixed(1)} kg exotic · ${fmtTime(l.time)}`, state };
    if (l.kind === 'refuel') return { text: `Refuel at ${l.at.name}`, detail: `skim the star's corona · ~${fmtTime(l.time)}`, state };
    if (l.kind === 'orbit') return { text: `Orbit ${l.body}`, detail: 'equatorial, default altitude', state };
    return { text: `Rendezvous · ${l.station}`, detail: 'match its orbit, hold 2 km off', state };
  });
  const jumps = r?.legs.filter((l) => l.kind === 'jump') ?? [];
  const time = r?.legs.reduce((t, l) => t + l.time, 0) ?? 0;
  const ly = jumps.reduce((t, l) => t + (l.kind === 'jump' ? l.ly : 0), 0);
  return {
    unit: nav ? unitLabel(nav).toUpperCase() : 'NO NAVIGATION COMPUTER',
    dest: r?.destName ?? '—',
    modes: nav?.caps.optimise ? NAV_MODES.map((m) => ({ label: m.label, on: g.navMode === m.id })) : null,
    legs,
    totals: r ? (jumps.length ? `${jumps.length} jumps · ${ly.toFixed(1)} ly · ${r.exoticNeeded.toFixed(1)} kg exotic (have ${g.ship.exotic.toFixed(0)}) · ~${fmtTime(time)}` : `~${fmtTime(time)}`) : '',
    warning: g.navError ? { text: g.navError, warn: true } : r?.warning ? { text: r.warning, warn: true } : null,
    running: !!r?.running,
    status: r?.running ? r.status : '',
    confirm: g.navConfirm > 0,
    hint: r?.running ? '' : 'Click a star or search (stars, planets, moons, stations) to add a stop · Backspace removes the last',
    points: [...g.navPoints.map((p) => p.name), ...(g.navFinal ? [`${g.navFinal.kind === 'station' ? '▢' : '◯'} ${g.navFinal.name}`] : [])],
    query: g.navQuery,
    sortFrom: g.navSortFrom,
    // computed while the panel is open (not only with a query): the dropdown lists what's nearest on focus
    results: searchNav(g, g.navQuery, g.navSortFrom).map(({ key, kind, name, detail }) => ({ key, kind, name, detail })),
  };
}

function planner(g: Game): PlannerView | null {
  const p = g.planner;
  if (!p) return null;
  const { ship } = g;
  const b = p.body,
    ev = evalPlan(p, ship);
  const far = Math.abs(ship.pos.distanceTo(b.pos) - ev.r0) > 3e6;
  const oc = ship.avionics.orbit;
  return {
    unit: oc ? unitLabel(oc).toUpperCase() : '',
    types: oc ? oc.caps.types : [],
    body: `${b.name} · ${b.typeName}`,
    type: p.type,
    alt: fmtDist(ev.r0 - b.radius) + (p.type === 'sync' ? ' (fixed)' : p.type === 'ring' && b.kind !== 'star' && b.ring ? ` · ${Math.round(((ev.r0 / b.radius - b.ring.inner) / (b.ring.outer - b.ring.inner)) * 100)} % across the ring` : ''),
    period: isFinite(ev.period) ? fmtTime(ev.period) : 'not orbiting',
    speed: ev.speed ? fmtSpeed(ev.speed).join(' ').toLowerCase() : '0 m/s',
    dir: p.type === 'hold' ? '—' : p.type === 'sync' ? 'with rotation (required)' : p.type === 'ring' ? 'with the ring (required)' : p.dir > 0 ? 'prograde (with rotation)' : 'retrograde',
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
