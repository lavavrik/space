import type { SystemsView } from '../../game/hud/types';
import { Bar, Heading, Row, Sub } from './primitives';

/** Propellant, exotic matter and electrical power. */
export function ShipSystems({ s }: { s: SystemsView }) {
  return (
    <section id="sys" className="pan">
      <Heading right={s.mass}>SHIP SYSTEMS</Heading>
      <div className="gauge">
        <Row label="PROPELLANT · H₂" value={s.prop} />
        <Bar frac={s.propFrac} lowWarn />
        <Sub left={<span>{s.deltaV}</span>} right={<span className={s.flow.warn ? 'warnc' : undefined}>{s.flow.text}</span>} />
      </div>
      <div className="gauge">
        <Row label="EXOTIC MATTER · FTL" value={s.exotic} />
        <Bar frac={s.exoticFrac} variant="ftl" lowWarn />
        <Sub left={<span>{s.jumps}</span>} right={<span>{s.exoticRate}</span>} />
      </div>
      <div className="gauge">
        <Row label="BATTERY" value={s.batt} />
        <Bar frac={s.battFrac} variant="batt" lowWarn />
        <Sub left={<span className={s.net.warn ? 'warnc' : undefined}>{s.net.text}</span>} right={<span>{s.battTime}</span>} />
      </div>
      <Row label="SOLAR" value={s.solar} />
      <Row label="LOAD" value={s.load} />
      {s.note && <p className="onote">{s.note}</p>}
    </section>
  );
}
