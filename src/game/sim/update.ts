import { rideTraffic, updateTraffic } from './traffic';
import { noAero, updateAero } from './atmosphere';
import { JUMP_DEPART_TIME, SHIP } from '../constants';
import type { Game } from '../Game';
import { THREE } from '../lib/three';
import { autopilot, ftlTransfer } from './autopilot';
import { collide, manualFlight, respawn } from './flight';
import { chargeFTL, ftlCruise } from './ftl';
import { gravityAt } from './gravity';
import { updateGuide } from './guide';
import { arriveAt, galPos } from './navigation';
import { departDist, departSpeed } from './hyperspace';
import { advanceBodies, frameVel, relVel, ringFrameOf, syncFrame, updateFrame } from './frame';
import { maybeFtlLeg } from './planner';
import { updateScan } from './scanner';
import { updateNav } from './navroute';
import { scoop, shipMass, solarPower, turnThrust } from './resources';
import { crossSection, updateThermal } from './thermal';
import { battCap, beginPower, grant, loadShed, settleBattery } from './power';
import { railsStep, stopWarp, warpBlocked } from './timewarp';
import { updatePivot } from './pivot';
import { updateRadar } from './radar';
import { autodock } from './autodock';
import { ascent, stopAscent } from './catapult';
import { updateDamage } from './damage';
import { PRICE, fmtCr, refuelQuote } from './economy';
import { ringContact } from './ringContact';
import { updateBelt } from './belt';
import { mineRock, updateLaser } from './laser';
import { SHORE_POWER, holdDocked, rotationCorrection, stationContact, updateDockRequest } from './docking';
import { updateContracts } from './contracts';
import { laserIdle } from './laser';
import { breathe, cryo, gatherO2, waterIn } from './oxygen';
import { destroyShip } from './flight';
import { shipContacts } from './shipContact';
import { updateWrecks } from './wreck';

/** A turn asked for (rad/s) above this cancels sun tracking (below: jitter, a turn coasting down). */
const STEER_CANCEL = 0.05;

const qa = new THREE.Quaternion();
const AX = new THREE.Vector3(1, 0, 0),
  AY = new THREE.Vector3(0, 1, 0),
  AZ = new THREE.Vector3(0, 0, 1);
const MOUSE_SENS = 0.0021;
/**
 * Turning has mass (Game.angVel): the mouse, the arrows and Q/E ask for a turn rate, and the ship's
 * attitude thrusters get there at ANG_ACC (rad/s², for a ship of ANG_REF_MASS: slower when heavier,
 * e.g. with a full hold), and stop it again at the same rate when you let go. It used to turn exactly
 * as the mouse moved: no resistance at all.
 */
/** The mouse's turn-rate demand is smoothed over this (s). */
const MOUSE_SMOOTH = 0.12;
const ANG_ACC = 3,
  ANG_REF_MASS = 200e3;
/** Under time warp in a ring's belt, drift slower than this (m/s) against the rocks is snapped to their orbit. */
const RING_SNAP = 5;
/** Headlights' draw (kW): a few floodlights. */
const LIGHTS_KW = 5;

/**
 * Advance the simulation by dt seconds. Under time warp dt is the warped step and realDt the frame's
 * real time: steering, messages and flashes run on real time (sim/timewarp.ts).
 */
export function update(g: Game, dt: number, realDt = dt) {
  const { ship, keys, power, input } = g;
  if (g.warp > 1) {
    const why = warpBlocked(g);
    if (why) {
      stopWarp(g, why);
      dt = realDt;
    }
  }
  g.simTime += dt;
  Object.assign(g.aero, noAero()); // set again below if the ship is flying through air
  const inTunnel = !!g.jump && g.jump.phase === 'tunnel';
  // departing: the jump flies the ship (straight out along the nose), no steering or physics
  const departing = !!g.jump && g.jump.phase === 'depart';

  if (ship.dead) {
    advanceBodies(g);
    ship.dead.t -= dt;
    updateGuide(g, dt);
    if (ship.dead.t <= 0) respawn(g);
    input.consumeMouse();
    ship.grav = gravityAt(g.cur, ship.pos);
    g.curSpeed = 0;
    return;
  }
  const apSteering = !!ship.ap && ship.ap.phase === 'transfer';
  beginPower(g); // this frame's power budget (sim/power.ts)
  updateRadar(g, dt);
  power.lightsKW = g.lights ? grant(g, LIGHTS_KW, 'headlights') : 0;

  // --- rotation
  let [mdx, mdy] = input.consumeMouse();
  // the system map open: the mouse turns the map's view, not the ship
  if (g.map.open) {
    g.overlay.map.rotate(g, mdx, mdy);
    mdx = mdy = 0;
  }
  // while the hyperdrive charges it swings the nose onto the destination (updateJump): no manual
  // steering, pivot or sun tracking fighting it
  const jumpCharging = g.jump?.phase === 'charge';
  if (!inTunnel && !departing && !apSteering && !jumpCharging) {
    // through the periscope, steering slows by the magnification so a target can be held
    const zs = 1 / g.zoom.cur;
    // the turn rate asked for (rad/s): the mouse's motion this frame, the arrows, Q/E
    // (the mouse's rate, smoothed over MOUSE_SMOOTH: a hand's motion comes in uneven per-frame steps,
    // and chasing each one kept the attitude thrusters firing ~30 kg/s through a steady turn)
    const inv = realDt > 1e-4 ? 1 / realDt : 0;
    const mk = 1 - Math.exp(-realDt / MOUSE_SMOOTH);
    g.mouseRate.x += (-mdy * MOUSE_SENS * zs * inv - g.mouseRate.x) * mk;
    g.mouseRate.y += (-mdx * MOUSE_SENS * zs * inv - g.mouseRate.y) * mk;
    let wp = g.mouseRate.x,
      wy = g.mouseRate.y,
      wr = 0;
    const kr = (ship.mode === 'ftl' ? 0.8 : 1.1) * zs;
    if (keys.ArrowUp) wp += kr;
    if (keys.ArrowDown) wp -= kr;
    if (keys.ArrowLeft) wy += kr;
    if (keys.ArrowRight) wy -= kr;
    if (keys.KeyQ) wr += 1.4;
    if (keys.KeyE) wr -= 1.4;
    // sun tracking gives way only to a real ask to turn: a turn still coasting down from the last
    // mouse move (the smoothed rate takes a while to settle) cancelled it the moment it came on;
    // while it's on, the leftover rate is dropped and the thrusters bring the turn to rest
    if (ship.sunTrack) {
      if (Math.hypot(wp, wy, wr) > STEER_CANCEL) {
        ship.sunTrack = false;
        g.showMsg('Sun tracking off · manual steering');
      } else {
        wp = wy = wr = 0;
        g.mouseRate.set(0, 0, 0);
      }
    }
    // the attitude thrusters bring the turn rate there (and back to rest) at ANG_ACC, less if heavy
    const acc = ANG_ACC * zs * Math.min(1.5, ANG_REF_MASS / shipMass(ship)) * realDt;
    const av = g.angVel;
    const step = (w: number, want: number) => Math.max(-acc, Math.min(acc, want - w));
    const dx = step(av.x, wp),
      dy = step(av.y, wy),
      dz = step(av.z, wr);
    // the attitude thrusters pay for it (sim/resources.ts turnThrust), and deliver only what they can
    const got = turnThrust(g, Math.hypot(dx, dy, dz), realDt);
    av.set(av.x + dx * got, av.y + dy * got, av.z + dz * got);
    const pitch = av.x * realDt,
      yaw = av.y * realDt,
      roll = av.z * realDt;
    // (something else turned the ship since steering last did: the pivot, an autopilot, docking...)
    const turnedElsewhere = !ship.q.equals(g.steerQ);
    ship.q.multiply(qa.setFromAxisAngle(AY, yaw)).multiply(qa.setFromAxisAngle(AX, pitch)).multiply(qa.setFromAxisAngle(AZ, roll)).normalize();
    // (something else turning the ship takes over its turn; a roll under way moves the reference)
    if (turnedElsewhere) av.set(0, 0, 0);
    if (av.z !== 0 || turnedElsewhere || !g.steerUp) g.steerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
    else if (pitch !== 0 || yaw !== 0) lockRoll(g);
    // middle-click pivot (sim/pivot.ts); a deliberate mouse move or steering key takes over, jitter doesn't
    const steered = Math.abs(mdx) + Math.abs(mdy) > 2 || keys.ArrowUp || keys.ArrowDown || keys.ArrowLeft || keys.ArrowRight || keys.KeyQ || keys.KeyE;
    updatePivot(g, realDt, !!steered);
    if (g.pivot) {
      g.steerUp = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
      av.set(0, 0, 0); // (the pivot turns the ship its own way)
    }
    g.steerQ.copy(ship.q);
  }
  g.qInv.copy(ship.q).invert();
  g.fwd.set(0, 0, -1).applyQuaternion(ship.q);
  // coupled, the FTL drive pushes along the nose; decoupled, it keeps its last direction
  if (!ship.decoupled || apSteering) ship.travelDir.copy(g.fwd);

  // --- charging and hyperjumps
  chargeFTL(g, dt);
  updateJump(g, dt);

  // --- orbits and spin (the ship rides along with its frame body, as do the other ships)
  if (!inTunnel) rideTraffic(g);
  advanceBodies(g);
  if (!inTunnel) updateTraffic(g, dt); // other ships (sim/traffic.ts)
  updateFrame(g);

  // --- movement
  const down = keys.ControlLeft || keys.ControlRight || keys.KeyC;
  const inp = [(keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0), (keys.Space ? 1 : 0) - (down ? 1 : 0), (keys.KeyS ? 1 : 0) - (keys.KeyW ? 1 : 0)];
  const anyInput = inp[0] || inp[1] || inp[2] || keys.KeyX;
  // the autopilot keeps control: manual input is ignored (with a reminder) rather than switching
  // it off, which was far too easy to do by accident; disengage from its status panel (O)
  if (ship.ap) {
    if (anyInput && !g.warned.apInput) {
      g.warned.apInput = true;
      g.showMsg('The autopilot is flying · O for its status (disengage there)', 'warn');
    }
    if (!anyInput) g.warned.apInput = false;
    inp[0] = inp[1] = inp[2] = 0;
  }
  if (g.apConfirm > 0 && (g.apConfirm -= dt) <= 0) {
    g.apConfirm = 0;
    g.invalidateHud();
  }
  if (!ship.ap) g.apPanel = false;

  if (g.warp > 1 || g.dock?.docked || ship.mode !== 'normal') {
    g.laser.end = g.laser.hit = null;
    g.laser.rate = 0;
    g.power.laserKW = 0;
    g.rockThreat = null;
    g.nudging = false;
  }
  if (!inTunnel && !departing) {
    if (g.warp > 1) {
      // time warp: coast on rails under the frame body's gravity
      ship.grav = gravityAt(g.cur, ship.pos);
      if (g.dock?.docked) holdDocked(g);
      else {
        // in a ring's belt drifting with its rocks: on rails exactly on their orbit. A leftover m/s
        // (the autopilot settles within 1) swings you round a ~±10 km loop about your spot once an
        // orbit: invisible in real time (hours), but under warp the whole field slid back and forth.
        if (ringFrameOf(g) && relVel(g).length() < RING_SNAP) ship.vel.copy(frameVel(g));
        railsStep(g, dt);
      }
      // on the ground the air still heats (or cools) the hull under warp
      if (ship.landed) updateAero(g, dt, (u) => crossSection(g, u), shipMass(ship));
      g.curSpeed = relVel(g).length();
    } else if (g.dock?.docked) {
      // docked: held on the pad, turning with the station
      ship.grav = gravityAt(g.cur, ship.pos);
      syncFrame(g, ship.grav.body);
      holdDocked(g);
    } else if (ship.mode === 'normal') {
      const grav = (ship.grav = gravityAt(g.cur, ship.pos));
      syncFrame(g, grav.body);
      maybeFtlLeg(g);
      rotationCorrection(g, dt);
      // after a sky station's catapult: the ascent program flies until clear of the air or a thrust key
      if (g.ascent && anyInput) stopAscent(g, 'Ascent program off · you have control');
      if (g.autodock) autodock(g, dt, grav.vec);
      else if (g.ascent && ascent(g, dt, grav)) {
        /* flown by the ascent program */
      } else if (ship.ap && ship.ap.phase === 'insert') autopilot(g, dt, grav);
      else manualFlight(g, dt, grav, inp);
      // ring dust, the deflector, the collision radar's nudge (sim/belt.ts; sideways input: the pilot is steering)
      updateBelt(g, dt, inp[0] !== 0 || inp[1] !== 0);
      updateAero(g, dt, (u) => crossSection(g, u), shipMass(ship)); // drag and entry heating
      ship.pos.addScaledVector(ship.vel, dt);
      collide(g, dt);
      stationContact(g);
      ringContact(g, dt); // the ring's rocks (sim/ringContact.ts)
      // the mining laser's beam (sim/laser.ts; its yield goes in with the scoop's). After the move:
      // mid-step the ship lags the rocks by its orbital motion (~700 m a frame round a giant)
      updateLaser(g);
      g.curSpeed = relVel(g).length();
    } else if (apSteering) {
      ftlTransfer(g, dt);
    } else {
      ftlCruise(g, dt);
    }
  }

  if (ship.mode === 'ftl' && !departing) {
    ship.grav = gravityAt(g.cur, ship.pos);
    syncFrame(g, ship.grav.body);
  }

  // --- power, fuel, refuelling
  if (ship.sunTrack && !apSteering && !inTunnel && !departing && !g.jump) {
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q);
    const toS = g.cur.star.pos.clone().sub(ship.pos).normalize();
    const dq = new THREE.Quaternion().setFromUnitVectors(up, toS);
    ship.q.slerp(dq.multiply(ship.q), Math.min(1, 1.2 * dt)).normalize();
  }
  // no sunlight inside a station; docked, the station's shore power stands in for the panels
  power.solar = inTunnel || g.inStation ? 0 : solarPower(g);
  power.shore = g.dock?.docked ? SHORE_POWER : 0;
  // oxygen (sim/oxygen.ts): split from water on spare power (it asks last), scooped from the air
  ship.boil = cryo(g, dt); // the cryocoolers, or boil-off (sim/oxygen.ts)
  ship.o2Rate = gatherO2(g, dt, waterIn(g));
  power.draw = SHIP.baseLoad + power.thrustKW + power.ftlKW + power.chargeKW + power.pumpKW + power.radarKW + power.lightsKW + power.shieldKW + power.guardKW + power.laserKW + power.cryoKW + power.electrolysisKW;
  settleBattery(g, dt);
  // life support breathes the tank (docked: the station's air); empty, the crew is lost
  if (breathe(g, dt) && !ship.dead) destroyShip(g, 'Life support failed · the oxygen ran out', g.frameBody);
  loadShed(g);
  if (ship.batt > 1) g.warned.batt = false;
  updateThermal(g, dt, inTunnel);
  updateDamage(g, dt); // (heat wear; impacts are taken where they happen)
  // dt can be 0 (two frames on one timestamp); 0/0 would stick NaN in the smoothed rate forever
  if (dt > 0) ship.burnRate += (power.burn / dt - ship.burnRate) * Math.min(1, dt * 3);
  if (!inTunnel) scoop(g, dt);
  mineRock(g, dt); // the rock the laser mines shrinks (sim/laser.ts)
  updateTanker(g, dt);
  updateDockRequest(g, dt);
  updateGuide(g, dt);
  updateScan(g, dt);
  updateNav(g, dt);
  updateContracts(g); // deliveries on docking, deadlines (sim/contracts.ts)
  laserIdle(g); // the laser goes off after LASER_IDLE with nothing in its beam
  if (!inTunnel) shipContacts(g); // ships bumping into ships, yours included (sim/shipContact.ts)
  updateWrecks(g, dt); // your lost ships' wrecks: falling, and salvaged (sim/wreck.ts)

  // --- nearest body
  g.nearest = null;
  g.nearestAlt = Infinity;
  for (const b of g.cur.bodies) {
    const alt = b.pos.distanceTo(ship.pos) - b.radius;
    if (alt < g.nearestAlt) {
      g.nearestAlt = alt;
      g.nearest = b;
    }
  }

  if (g.msg.t > 0) {
    g.msg.t -= realDt;
    if (g.msg.t <= 0) g.msg.on = false;
  }
  if (g.flash > 0) g.flash = Math.max(0, g.flash - realDt * 1.4);
}

function updateJump(g: Game, dt: number) {
  const { jump, ship } = g;
  if (!jump) return;
  if (jump.phase === 'charge') {
    // the charge takes a fixed energy: at less than full power it takes longer
    const kw = ship.breakers.charge ? grant(g, SHIP.jumpChargeKW, 'hyperdrive charging') : 0; // switched off: the charge pauses
    g.power.chargeKW = kw;
    jump.t -= (dt * kw) / SHIP.jumpChargeKW;
  } else jump.t -= dt;
  if (jump.phase === 'charge') {
    // swing the nose onto the destination while the drive charges; the transit flies straight at it
    const to = jump.dest.pos.clone().sub(jump.from).normalize();
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), to, new THREE.Vector3(0, 1, 0).applyQuaternion(ship.q));
    ship.q.slerp(new THREE.Quaternion().setFromRotationMatrix(m), Math.min(1, (jump.t <= 0 ? 1 : 1.6 * dt)));
  }
  if (jump.phase === 'charge' && jump.t <= 0) {
    // drive engaged: accelerate straight out along the nose (now on the destination)
    jump.phase = 'depart';
    jump.t = JUMP_DEPART_TIME;
    ship.exotic = Math.max(0, ship.exotic - jump.cost);
    ship.ap = null;
    g.refFrame = null;
    g.showMsg(`Hyperdrive engaged · ${jump.dest.name} · ${jump.cost.toFixed(1)} kg exotic matter used`, 'ftl');
  } else if (jump.phase === 'depart') {
    const t1 = JUMP_DEPART_TIME - Math.max(0, jump.t);
    const t0 = Math.max(0, t1 - dt);
    ship.pos.addScaledVector(g.fwd, departDist(t1) - departDist(t0));
    g.curSpeed = departSpeed(t1);
    if (jump.t <= 0) {
      jump.phase = 'tunnel';
      jump.t = jump.dur;
      jump.from = galPos(g); // wherever the departure left us, a few hundred AU out
      g.showMsg(`Hyperspace · ${jump.dest.name}`, 'ftl');
    }
  } else if (jump.phase === 'tunnel') {
    if (jump.t <= 0) {
      arriveAt(g, jump.dest, jump.dest.pos.clone().sub(jump.from));
      g.flash = 1;
      const s = g.cur.sys.star;
      g.showMsg(`Arrived at ${g.cur.sys.name} · ${s.spec} · throttle up with W`, 'ftl');
      g.jump = null;
    }
  }
}

function updateTanker(g: Game, dt: number) {
  const { ship } = g;
  if (!ship.tanker) return;
  if (ship.mode !== 'normal' || g.curSpeed > 200) {
    ship.tanker = null;
    g.showMsg('Tanker rendezvous cancelled · hold still below 200 m/s', 'warn');
  } else if ((ship.tanker.t -= dt) <= 0) {
    ship.tanker.docked = true;
    ship.tanker = null;
    // the call-out fee, then its fuel at a mark-up as far as your credits go (the battery's charge
    // comes free with the call)
    g.credits = Math.max(0, g.credits - PRICE.tankerCall);
    const q = refuelQuote(g, null, PRICE.tankerMarkup);
    const prop = Math.min(q.prop, g.credits / q.pp);
    g.credits -= prop * q.pp;
    const exotic = Math.min(q.exotic, g.credits / q.px);
    g.credits -= exotic * q.px;
    ship.prop += prop;
    ship.exotic += exotic;
    ship.batt = battCap(ship);
    const cost = PRICE.tankerCall + prop * q.pp + exotic * q.px;
    g.showMsg(prop < q.prop - 1 ? `Tanker docked · ${fmtCr(cost)} · out of credits: tanks part-filled` : `Tanker docked · tanks and battery full · ${fmtCr(cost)}`, prop < q.prop - 1 ? 'warn' : '');
  }
}

/**
 * Manual steering never rolls the ship: only Q/E do. Turning by the mouse or the arrows is a yaw and
 * a pitch about the ship's own axes each frame, and a loop of those adds up to a roll (circling the
 * mouse slowly screwed the horizon round). So while you steer, the ship's top is held to a reference
 * "up" (Game.steerUp, its part across the nose). Q/E move the reference; anything else that turns
 * the ship (the pivot, autopilots, docking, sun tracking) re-seeds it from where it left the ship;
 * looking straight along it (a pitch over the top) re-seeds it too, since there's no "up" to keep.
 */
function lockRoll(g: Game) {
  const { ship } = g;
  const ref = g.steerUp!;
  lrNose.set(0, 0, -1).applyQuaternion(ship.q);
  lrWant.copy(ref).addScaledVector(lrNose, -ref.dot(lrNose));
  if (lrWant.lengthSq() < 0.02) {
    ref.set(0, 1, 0).applyQuaternion(ship.q); // looking along it: nothing to hold to
    return;
  }
  lrWant.normalize();
  // the ship's axes with its top on the reference, the nose unchanged: x = up × back
  lrBack.copy(lrNose).negate();
  lrX.crossVectors(lrWant, lrBack).normalize();
  lrM.makeBasis(lrX, lrWant, lrBack);
  ship.q.setFromRotationMatrix(lrM).normalize();
}

const lrNose = new THREE.Vector3(),
  lrWant = new THREE.Vector3(),
  lrBack = new THREE.Vector3(),
  lrX = new THREE.Vector3(),
  lrM = new THREE.Matrix4();
