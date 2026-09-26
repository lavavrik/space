import type { InfoView } from '../../game/hud/types';
import { Panel, Row } from './primitives';

/** Target details (I, in place of the controls list): physical data, the target's own orbit, and the ship relative to it. */
export function BodyInfo({ info }: { info: InfoView }) {
  return (
    <Panel name="info" id="info" className="pan" title={info.title.toUpperCase()} right="I HIDES">
      <div className="itype">{info.type}</div>
      {info.physical.map(([k, v]) => (
        <Row key={k} label={k} value={v} />
      ))}
      <div className="isec">{info.orbitHead}</div>
      {info.orbit.map(([k, v]) => (
        <Row key={k} label={k} value={v} />
      ))}
      <div className="isec">YOUR SHIP</div>
      {info.you.map(([k, v]) => (
        <Row key={k} label={k} value={v} />
      ))}
    </Panel>
  );
}
