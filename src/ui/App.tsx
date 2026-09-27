import { AutopilotPanel } from './components/AutopilotPanel';
import { AvionicsPanel } from './components/AvionicsPanel';
import { BodyInfo } from './components/BodyInfo';
import { HelpPanel } from './components/HelpPanel';
import { FlightCluster, Location, ShipGauges, TargetCard } from './components/Hud';
import { ManeuverGuide } from './components/ManeuverGuide';
import { OrbitPlanner } from './components/OrbitPlanner';
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
          <div id="leftcol">
            <Location loc={hud.location} />
            {hud.info ? <BodyInfo info={hud.info} /> : hud.avionics ? <AvionicsPanel slots={hud.avionics} /> : hud.helpVisible && <HelpPanel />}
          </div>
          <div id="rightcol">
            {hud.autopilot && <AutopilotPanel a={hud.autopilot} onDisengage={() => game!.requestDisengage()} onChange={() => game!.changeOrbit()} />}
            {hud.guide && <ManeuverGuide guide={hud.guide} />}
            {hud.planner && <OrbitPlanner p={hud.planner} />}
          </div>
          {hud.showRelock && <div id="relock">CLICK: TARGET OR CAPTURE MOUSE · DRAG STEERS</div>}
          <div id="hud">
            <ShipGauges s={hud.systems} />
            <div id="centre">
              <Toast toast={hud.toast} />
              <FlightCluster f={hud.flight} />
            </div>
            <TargetCard t={hud.target} />
          </div>
          {!hud.started && <StartScreen onStart={() => game!.begin()} />}
        </>
      )}
    </>
  );
}
