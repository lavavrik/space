import { TANKER_TIME } from '../constants';
import type { Game } from '../Game';
import { toggleCruise, toggleDecoupled, toggleFTL } from '../sim/ftl';
import { startTankerGuide } from '../sim/guide';
import { pickDest, cycleTarget, startJump, targetAhead } from '../sim/navigation';
import { ORBIT_TYPES } from '../sim/orbits';
import { adjustAlt, closePlanner, engageOrbit, openPlanner, requestDisengage, reversePlannerDir, selectOrbitType, toggleOrbitPreview } from '../sim/planner';

/** Handle a key press (not held keys, which the simulation polls). */
export function onPress(g: Game, code: string) {
  const { ship, keys } = g;
  if (code === 'Backquote') g.perf.toggle(); // performance overlay, available any time
  if (!g.started) return;
  g.invalidateHud();
  if (code === 'Tab') g.helpVisible = !g.helpVisible;
  if (code === 'KeyI') {
    g.infoVisible = !g.infoVisible;
    if (g.infoVisible && !g.target) g.showMsg('Target something (T, G or click) to see its details');
  }
  if ((g.jump && g.jump.phase === 'tunnel') || ship.dead) return;

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
      // while the autopilot flies, O shows its status instead of switching it off
      if (g.planner) closePlanner(g);
      else if (ship.ap) {
        g.apPanel = !g.apPanel;
        g.apConfirm = 0;
      } else if (g.jump) g.showMsg('Hyperdrive is charging', 'warn');
      else openPlanner(g);
      break;
    case 'KeyP':
      ship.sunTrack = !ship.sunTrack;
      g.showMsg(ship.sunTrack ? 'Sun tracking on · turning panels to the star (steer to cancel)' : 'Sun tracking off');
      break;
    case 'KeyK':
      if (ship.tanker) {
        ship.tanker = null;
        g.showMsg('Tanker call cancelled');
      } else if (ship.mode !== 'normal') g.showMsg('Drop out of FTL to meet a tanker', 'warn');
      else if (g.curSpeed > 200) g.showMsg('Slow below 200 m/s to meet a tanker', 'warn');
      else {
        ship.tanker = { t: TANKER_TIME };
        startTankerGuide(g, ship.tanker);
        g.showMsg(`Tanker on its way · hold still for ${TANKER_TIME} s`);
      }
      break;
    case 'KeyF':
      toggleCruise(g);
      break;
    case 'KeyL':
      toggleOrbitPreview(g);
      break;
    case 'KeyV':
      toggleDecoupled(g);
      break;
    case 'KeyZ':
      ship.fa = !ship.fa;
      g.showMsg(ship.fa ? 'Flight assist on' : 'Flight assist off · pure Newtonian flight');
      break;
    case 'KeyJ':
      if (ship.ap) {
        g.showMsg('The autopilot is flying · O for its status (disengage there)', 'warn');
        break;
      }
      toggleFTL(g);
      break;
    case 'KeyT':
      targetAhead(g);
      break;
    case 'KeyG':
      cycleTarget(g);
      break;
    case 'KeyN':
      pickDest(g);
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
  if (g.planner && g.started) adjustAlt(g, deltaY < 0 ? 1.1 : 1 / 1.1);
}
