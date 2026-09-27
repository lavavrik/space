import type { AvionicsSlotView } from '../../game/hud/types';
import { Panel, Row } from './primitives';

/** Avionics (U): the ship's fitted computers, one per kind, with maker, model and key specs. */
export function AvionicsPanel({ slots }: { slots: AvionicsSlotView[] }) {
  return (
    <Panel name="avionics" id="avionics" className="pan" title="AVIONICS" right="U HIDES">
      {slots.map((s) => (
        <div key={s.kind} className="avslot">
          <div className="isec">{s.kind}</div>
          <div className="avunit">{s.unit}</div>
          {s.maker && <div className="avmaker">{s.maker}</div>}
          {s.blurb && <div className="avblurb">{s.blurb}</div>}
          {s.specs.map(([k, v]) => (
            <Row key={k} label={k} value={v} />
          ))}
        </div>
      ))}
    </Panel>
  );
}
