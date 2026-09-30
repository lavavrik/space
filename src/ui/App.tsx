import { AutopilotPanel } from './components/AutopilotPanel';
import { AvionicsPanel } from './components/AvionicsPanel';
import { CargoPanel } from './components/CargoPanel';
import { ContractsPanel } from './components/ContractsPanel';
import { StationPanel } from './components/StationPanel';
import { PauseMenu } from './components/PauseMenu';
import { BodyInfo } from './components/BodyInfo';
import { HelpPanel } from './components/HelpPanel';
import { InfluencesPanel } from './components/InfluencesPanel';
import { FlightCluster, Location, ShipGauges, TargetCard } from './components/Hud';
import { ManeuverGuide } from './components/ManeuverGuide';
import { NavPanel } from './components/NavPanel';
import { OutfitPanel } from './components/OutfitPanel';
import { RadarPanel } from './components/RadarPanel';
import { OrbitPlanner } from './components/OrbitPlanner';
import { Toast } from './components/Toast';
import { useGame, useHud } from './hooks/useGame';
import { useLeftRoom } from './hooks/useLeftRoom';

export function App() {
  const { hostRef, game } = useGame();
  const hud = useHud(game);
  useLeftRoom(!!hud && !hud.mapOpen);
  return (
    <>
      <div ref={hostRef} />
      {hud?.pause && (
        <PauseMenu
          p={hud.pause}
          save={hud.save}
          act={{ resume: () => game!.resume(), controls: () => game!.showControls(), sound: () => game!.toggleSound(), names: () => game!.toggleNames(), save: () => game!.saveFromMenu(), newGame: () => game!.newGame(), jump: (id) => game!.debugJump(id), refill: () => game!.debugRefill() }}
        />
      )}
      {hud && hud.mapOpen && (
        // the system map covers the view (drawn on the HUD canvas): only the messages stay
        <div id="hud">
          <div id="centre">
            <Toast toast={hud.toast} />
          </div>
        </div>
      )}
      {hud && !hud.mapOpen && (
        <>
          <div id="leftcol">
            <Location loc={hud.location} />
            {hud.info ? <BodyInfo info={hud.info} /> : hud.influences ? <InfluencesPanel v={hud.influences} onTarget={(n) => game!.targetByName(n)} /> : hud.radar ? (
              <RadarPanel v={hud.radar} act={{ sweep: () => game!.radarSweep(), pick: (k, scan) => game!.radarPick(k, scan) }} />
            ) : hud.contracts ? (
              <ContractsPanel v={hud.contracts} act={{ accept: (id) => game!.acceptJob(id), deliver: (id) => game!.deliverJob(id), abandon: (id) => game!.abandonJob(id), plot: (id) => game!.plotJob(id) }} />
            ) : hud.cargo ? (
              <CargoPanel v={hud.cargo} act={{ sell: (c) => game!.sellOne(c), sellAll: () => game!.sellCargo(), jettison: (c) => game!.jettison(c) }} />
            ) : hud.outfit ? (
              <OutfitPanel
                v={hud.outfit}
                act={{ back: () => game!.openShipStats(), battery: (id) => game!.fitBattery(id), fit: (s, id) => game!.fitModule(s, id), remove: (s) => game!.removeModule(s), radiators: () => game!.toggleRadiators(), pump: () => game!.togglePump() }}
              />
            ) : hud.avionics ? <AvionicsPanel slots={hud.avionics} electrical={hud.electrical} onOpen={(k) => game!.openAvionics(k)} onToggle={(id) => game!.toggleLoad(id)} /> : hud.docked ? (
              <StationPanel
                d={hud.docked}
                act={{
                  tab: (t) => game!.setStationTab(t),
                  buyFuel: (f, kg) => game!.buyFuel(f, kg),
                  repair: () => game!.repairDocked(),
                  sell: (c) => game!.sellOne(c),
                  sellAll: () => game!.sellCargo(),
                  battery: (id) => game!.fitBattery(id),
                  fit: (s, id) => game!.fitModule(s, id),
                  remove: (s) => game!.removeModule(s),
                  radiators: () => game!.toggleRadiators(),
                  pump: () => game!.togglePump(),
                  cargo: () => game!.openCargo(),
                  launch: () => game!.launch(),
                  catapult: () => game!.catapult(),
                  accept: (id) => game!.acceptJob(id),
                  deliver: (id) => game!.deliverJob(id),
                  abandon: (id) => game!.abandonJob(id),
                  plot: (id) => game!.plotJob(id),
                }}
              />
            ) : hud.helpVisible && <HelpPanel save={hud.save} onNewGame={() => game!.newGame()} />}
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
          {hud.showRelock && (
            // with the mouse free: the button captures it (for when there's no empty space to click)
            <div id="relock">
              <span>CLICK: TARGET · DRAG STEERS</span>
              <button type="button" onClick={() => game!.captureMouse()}>CAPTURE MOUSE</button>
            </div>
          )}
          {hud.plasma > 0 && <div id="plasma" style={{ opacity: hud.plasma }} />}
          <div id="hud">
            <ShipGauges s={hud.systems} />
            <div id="centre">
              <Toast toast={hud.toast} />
              <FlightCluster f={hud.flight} lamps={hud.lamps} />
            </div>
            <TargetCard t={hud.target} />
          </div>
        </>
      )}
    </>
  );
}
