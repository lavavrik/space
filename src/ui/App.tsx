import { HelpPanel } from './components/HelpPanel';
import { Hud } from './components/Hud';
import { ManeuverGuide } from './components/ManeuverGuide';
import { OrbitPlanner } from './components/OrbitPlanner';
import { ShipSystems } from './components/ShipSystems';
import { StartScreen } from './components/StartScreen';
import { Toast } from './components/Toast';
import { useGame, useHud } from './hooks/useGame';

export function App() {
  const { hostRef, game } = useGame();
  const hud = useHud(game);
  return (
    <>
      <div ref={hostRef} />
      {hud && (
        <>
          {hud.helpVisible && <HelpPanel />}
          <div id="rightcol">
            <ShipSystems s={hud.systems} />
            {hud.guide && <ManeuverGuide guide={hud.guide} />}
            {hud.planner && <OrbitPlanner p={hud.planner} />}
          </div>
          {hud.showRelock && <div id="relock">CLICK SPACE TO CAPTURE MOUSE · CLICK OBJECTS TO TARGET · DRAG ALSO STEERS</div>}
          <Toast toast={hud.toast} />
          <Hud nav={hud.nav} flight={hud.flight} target={hud.target} />
          {!hud.started && <StartScreen onStart={() => game!.begin()} />}
        </>
      )}
    </>
  );
}
