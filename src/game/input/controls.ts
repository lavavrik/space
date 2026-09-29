import { TANKER_TIME } from '../constants';
import { dockKey } from '../sim/docking';
import { catapultLaunch } from '../sim/catapult';
import { toggleLaser } from '../sim/laser';
import { PRICE, fmtCr, refuelQuote } from '../sim/economy';
import { stopAutodock } from '../sim/autodock';
import { togglePeriscope, wheelZoom } from '../sim/periscope';
import { changeWarp, stopWarp } from '../sim/timewarp';
import { startPivot } from '../sim/pivot';
import { toggleRadiators, toggleVent } from '../sim/thermal';
import type { Game } from '../Game';
import { toggleCruise, toggleDecoupled, toggleFTL } from '../sim/ftl';
import { toggleScan } from '../sim/scanner';
import { engageRoute, NAV_MODES, removeNavPoint, replan, requestCancelRoute } from '../sim/navroute';
import { startTankerGuide } from '../sim/guide';
import { pickDest, cycleTarget, startJump, targetAhead } from '../sim/navigation';
import { ORBIT_TYPES } from '../sim/orbits';
import { adjustAlt, closePlanner, engageOrbit, openPlanner, requestDisengage, reversePlannerDir, selectOrbitType, toggleOrbitPreview } from '../sim/planner';

/** Handle a key press (not held keys, which the simulation polls). */
export function onPress(g: Game, code: string) {
  const { ship, keys } = g;
  if (code === 'Backquote') g.perf.toggle(); // performance overlay, available any time
  g.invalidateHud();
  if (code === 'Tab') g.helpVisible = !g.helpVisible;
  // info (I), avionics (U), outfit (Shift+U), influences (B), radar (Shift+Y) and cargo (Shift+I)
  // share the left column: opening one closes the others
  const shift = !!(keys.ShiftLeft || keys.ShiftRight);
  if (code === 'KeyU' || code === 'KeyI' || code === 'KeyB' || (code === 'KeyY' && shift)) {
    const outfit = code === 'KeyU' && shift,
      radar = code === 'KeyY',
      cargo = code === 'KeyI' && shift;
    const was = outfit ? g.outfitVisible : radar ? g.radarVisible : cargo ? g.cargoVisible : { KeyU: g.avionicsVisible, KeyI: g.infoVisible, KeyB: g.influencesVisible }[code as 'KeyU' | 'KeyI' | 'KeyB'];
    g.avionicsVisible = g.infoVisible = g.influencesVisible = g.outfitVisible = g.radarVisible = g.cargoVisible = false;
    g.jettisonArm = null;
    if (outfit) g.outfitVisible = !was;
    else if (radar) g.radarVisible = !was;
    else if (cargo) g.cargoVisible = !was;
    else if (code === 'KeyU') g.avionicsVisible = !was;
    if (code === 'KeyB') g.influencesVisible = !was;
    if (code === 'KeyI' && !cargo) {
      g.infoVisible = !was;
      if (g.infoVisible && !g.target) g.showMsg('Target something (T, G or click) to see its details');
    }
    // ship stats, outfit and influences are clicked through (entries, refit buttons, body names):
    // free the cursor on opening (checked after every toggle above, or B was never seen as open)
    if (g.avionicsVisible || g.outfitVisible || g.influencesVisible || g.radarVisible || g.cargoVisible) document.exitPointerLock?.();
    if (radar || cargo) return; // Shift+Y and Shift+I are only their windows
  }
  if ((g.jump && g.jump.phase !== 'charge') || ship.dead) return;

  if (g.planner) {
    const big = keys.ShiftLeft || keys.ShiftRight;
    if (code === 'BracketRight') {
      adjustAlt(g, big ? 2 : 1.15);
      return;
    }
    if (code === 'BracketLeft') {
      adjustAlt(g, big ? 0.5 : 1 / 1.15);
      return;
    }
    if (code.startsWith('Digit')) {
      const t = ORBIT_TYPES[+code.slice(5) - 1];
      if (t) selectOrbitType(g, t);
      return;
    }
    if (code === 'KeyR') {
      reversePlannerDir(g);
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      engageOrbit(g);
      return;
    }
  }

  // time warp: . faster, , slower; any thrust key drops it (the ship is on rails while it runs)
  if (code === 'Period' || code === 'Comma') {
    changeWarp(g, code === 'Period' ? 1 : -1);
    return;
  }
  if (g.autodock && ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyC', 'ControlLeft', 'ControlRight', 'KeyX'].includes(code)) stopAutodock(g, 'Docking computer off · you have control');
  if (g.warp > 1 && ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space', 'KeyC', 'ControlLeft', 'ControlRight', 'KeyX', 'KeyJ', 'KeyH', 'KeyR'].includes(code)) stopWarp(g, 'manual control');

  // thermal: R vents hydrogen, Shift+R folds the radiators out or in (R is the planner's direction key while it's open)
  if (code === 'KeyR') {
    if (keys.ShiftLeft || keys.ShiftRight) toggleRadiators(g);
    else toggleVent(g);
    return;
  }

  // navigation panel: 1–3 route mode, Enter engages, Backspace clears the destination or
  // (twice) cancels a running route
  if (g.navPanel && !g.planner) {
    const r = g.route;
    if (code.startsWith('Digit') && !r?.running) {
      const m = NAV_MODES[+code.slice(5) - 1];
      if (m) {
        if (!ship.avionics.nav?.caps.optimise) g.showMsg(`${ship.avionics.nav?.model ?? 'This unit'} plans for least exotic matter only`, 'warn');
        else {
          g.navMode = m.id;
          replan(g);
        }
      }
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      if (r && !r.running) engageRoute(g);
      else if (!r) g.showMsg(g.navError ?? 'No route', 'warn');
      return;
    }
    if (code === 'Slash' && !r?.running) {
      // search for a star: free the mouse and put the cursor in the search box
      document.exitPointerLock?.();
      (document.getElementById('navsearch') as HTMLInputElement | null)?.focus();
      return;
    }
    if (code === 'Backspace') {
      if (r?.running) requestCancelRoute(g);
      else removeNavPoint(g);
      return;
    }
  }

  // autopilot status panel: Backspace (twice) disengages, Enter plans a different orbit
  if (ship.ap && g.apPanel && !g.planner) {
    if (code === 'Backspace') {
      requestDisengage(g);
      return;
    }
    if (code === 'Enter' || code === 'NumpadEnter') {
      g.apPanel = false;
      openPlanner(g);
      g.showMsg('Plan the new orbit · the autopilot keeps flying until you engage it');
      return;
    }
  }

  switch (code) {
    case 'KeyO':
      // Shift+O: the system map (render/SystemMap.ts)
      if (keys.ShiftLeft || keys.ShiftRight) {
        g.overlay.map.toggle(g);
        g.invalidateHud();
        break;
      }
      // while the autopilot flies, O shows its status instead of switching it off
      g.navPanel = false;
      if (g.planner) closePlanner(g);
      else if (ship.ap) {
        g.apPanel = !g.apPanel;
        g.apConfirm = 0;
      } else if (g.jump) g.showMsg('Hyperdrive is charging', 'warn');
      else openPlanner(g);
      break;
    case 'KeyP':
      // Shift+P: sound on / off (audio/ShipAudio.ts); P: sun tracking
      if (keys.ShiftLeft || keys.ShiftRight) {
        g.showMsg(g.audio.toggleMute() ? 'Sound on' : 'Sound off · Shift+P turns it back on');
        break;
      }
      if (g.jump) {
        g.showMsg('Hyperdrive is charging · it holds the nose on the destination', 'warn');
        break;
      }
      ship.sunTrack = !ship.sunTrack;
      g.showMsg(ship.sunTrack ? `Sun tracking on · turning panels to the star (steer to cancel)${g.pivot ? ' · target lock released' : ''}` : 'Sun tracking off');
      break;
    case 'KeyK':
      // K is docking (request, docking computer, launch); Shift+K calls a tanker, or docked at a sky
      // station fires the catapult (sim/catapult.ts)
      if ((keys.ShiftLeft || keys.ShiftRight) && g.dock?.docked && g.dock.station.sky) {
        catapultLaunch(g);
        break;
      }
      if (!(keys.ShiftLeft || keys.ShiftRight)) {
        if (!dockKey(g)) g.showMsg('Target a station to dock at · Shift+K calls a tanker', 'warn');
        break;
      }
      if (ship.tanker) {
        ship.tanker = null;
        g.showMsg('Tanker call cancelled');
      } else if (ship.mode !== 'normal') g.showMsg('Drop out of FTL to meet a tanker', 'warn');
      else if (g.curSpeed > 200) g.showMsg('Slow below 200 m/s to meet a tanker', 'warn');
      else if (g.credits < PRICE.tankerCall) g.showMsg(`A tanker's call-out is ${fmtCr(PRICE.tankerCall)} · you have ${fmtCr(g.credits)}`, 'warn');
      else {
        ship.tanker = { t: TANKER_TIME };
        startTankerGuide(g, ship.tanker);
        const q = refuelQuote(g, null, PRICE.tankerMarkup);
        g.showMsg(`Tanker on its way · hold still for ${TANKER_TIME} s · ${fmtCr(PRICE.tankerCall + q.cost)} with the fuel`);
      }
      break;
    case 'KeyF':
      toggleCruise(g);
      break;
    case 'KeyM':
      // Shift+M: the mining laser (sim/laser.ts); M: the navigation computer
      if (keys.ShiftLeft || keys.ShiftRight) {
        toggleLaser(g);
        break;
      }
      g.navPanel = !g.navPanel;
      if (g.navPanel) document.exitPointerLock?.(); // search box, buttons, clicking stars to add them
      if (g.navPanel) {
        if (!ship.avionics.nav) {
          g.navPanel = false;
          g.showMsg('No navigation computer fitted · see avionics (U)', 'warn');
          break;
        }
        closePlanner(g);
        g.apPanel = false;
        replan(g);
      }
      break;
    case 'KeyY':
      toggleScan(g);
      break;
    case 'KeyL':
      // Shift+L: headlights; L: the orbit preview ring
      if (keys.ShiftLeft || keys.ShiftRight) {
        g.lights = !g.lights;
        g.showMsg(g.lights ? 'Headlights on' : 'Headlights off');
      } else toggleOrbitPreview(g);
      break;
    case 'KeyV':
      toggleDecoupled(g);
      break;
    case 'KeyZ':
      // Z: periscope; Shift+Z: flight assist
      if (keys.ShiftLeft || keys.ShiftRight) {
        ship.fa = !ship.fa;
        g.showMsg(ship.fa ? 'Flight assist on' : 'Flight assist off · pure Newtonian flight');
      } else togglePeriscope(g);
      break;
    case 'KeyJ':
      if (ship.ap) {
        g.showMsg('The autopilot is flying · O for its status (disengage there)', 'warn');
        break;
      }
      toggleFTL(g);
      break;
    case 'KeyT':
      // Shift+T: pivot onto the target (as the wheel click does); T: target what's ahead
      if (keys.ShiftLeft || keys.ShiftRight) startPivot(g);
      else targetAhead(g);
      break;
    case 'KeyG':
      cycleTarget(g);
      break;
    case 'KeyN':
      // N: pick a star to jump to; Shift+N: names on the HUD's markers on / off
      if (keys.ShiftLeft || keys.ShiftRight) {
        g.showNames = !g.showNames;
        g.showMsg(g.showNames ? 'Object names shown' : 'Object names hidden · Shift+N shows them');
      } else pickDest(g);
      break;
    case 'KeyH':
      startJump(g);
      break;
  }
}

/** Auto-repeat only matters for stepping the planner altitude. */
export function onRepeat(g: Game, code: string) {
  if (g.planner && (code === 'BracketLeft' || code === 'BracketRight')) onPress(g, code);
}

export function onWheel(g: Game, deltaY: number) {
  if (g.map.open) g.overlay.map.zoom(g, deltaY);
  else if (g.planner) adjustAlt(g, deltaY < 0 ? 1.1 : 1 / 1.1);
  else if (g.zoom.on) wheelZoom(g, deltaY);
}
