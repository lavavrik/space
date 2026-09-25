import type { FlightView, NavigationView, TargetView } from '../../game/hud/types';
import { Bar, Heading, Row, Sub } from './primitives';

function NavigationPanel({ nav }: { nav: NavigationView }) {
  return (
    <section className="pan side">
      <Heading right={nav.clock}>NAVIGATION</Heading>
      <Row label="SYSTEM" value={nav.system} />
      <Row label="STAR" value={nav.star} />
      <Row label="GALACTIC" value={nav.galactic} />
      <div className="sep" />
      <Row label="X" value={nav.x} />
      <Row label="Y" value={nav.y} />
      <Row label="Z" value={nav.z} />
    </section>
  );
}

function FlightPanel({ flight }: { flight: FlightView }) {
  return (
    <section className="pan mid">
      <div id="hMode" className={flight.modeClass}>
        {flight.mode}
      </div>
      <div className="spd">{flight.speed}</div>
      <div className="unit">{flight.unit}</div>
      <Bar frac={flight.barFrac} variant={flight.barFtl ? 'ftl' : undefined} />
      <Sub left={<span>{flight.barLabel}</span>} right={<span>{flight.barValue}</span>} />
      <Sub
        left={<span className={flight.flightAssist.warn ? 'warnc' : undefined}>{flight.flightAssist.text}</span>}
        right={<span className={flight.gravity.warn ? 'warnc' : undefined}>{flight.gravity.text}</span>}
      />
    </section>
  );
}

function TargetPanel({ target }: { target: TargetView }) {
  return (
    <section className="pan side">
      <Heading right={target.type}>TARGET</Heading>
      <Row label="BODY" value={target.body} />
      <Row label="DISTANCE" value={target.distance} />
      <Row label="ETA" value={target.eta} />
      <div className="sep" />
      <Row label="NEAREST" value={target.nearest} />
      <Row label="VERTICAL" value={target.vertical} />
      <Row label="ORBIT" value={target.orbit} />
      <Row label="JUMP TO" value={target.jump} />
    </section>
  );
}

/** Bottom HUD: navigation, flight and target panels. */
export function Hud({ nav, flight, target }: { nav: NavigationView; flight: FlightView; target: TargetView }) {
  return (
    <div id="hud">
      <NavigationPanel nav={nav} />
      <FlightPanel flight={flight} />
      <TargetPanel target={target} />
    </div>
  );
}
