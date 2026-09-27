import { AutopilotPanel } from './components/AutopilotPanel';
import { AvionicsPanel } from './components/AvionicsPanel';
import { BodyInfo } from './components/BodyInfo';
import { HelpPanel } from './components/HelpPanel';
import { InfluencesPanel } from './components/InfluencesPanel';
import { FlightCluster, Location, ShipGauges, TargetCard } from './components/Hud';
import { ManeuverGuide } from './components/ManeuverGuide';
import { NavPanel } from './components/NavPanel';
import { OutfitPanel } from './components/OutfitPanel';
import { OrbitPlanner } from './components/OrbitPlanner';
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
            {hud.info ? <BodyInfo info={hud.info} /> : hud.influences ? <InfluencesPanel v={hud.influences} onTarget={(n) => game!.targetByName(n)} /> : hud.outfit ? (
              <OutfitPanel
                v={hud.outfit}
                act={{ back: () => game!.openShipStats(), battery: (id) => game!.fitBattery(id), fit: (s, id) => game!.fitModule(s, id), remove: (s) => game!.removeModule(s), radiators: () => game!.toggleRadiators(), pump: () => game!.togglePump() }}
              />
            ) : hud.avionics ? <AvionicsPanel slots={hud.avionics} electrical={hud.electrical} onOpen={(k) => game!.openAvionics(k)} /> : hud.helpVisible && <HelpPanel />}
          </div>
          <div id="rightcol">
            {hud.nav && (
              <NavPanel
                n={hud.nav}
                a={{
                  onEngage: () => game!.engageRoute(),
                  onCancel: () => game!.cancelRoute(),
                  onQuery: (q) => game!.setNavQuery(q),
                  onSort: (f) => game!.setNavSort(f),
                  onAdd: (key) => game!.addNavResult(key),
                  onRemoveLast: () => game!.removeNavPoint(),
                }}
              />
            )}
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
        </>
      )}
    </>
  );
}
