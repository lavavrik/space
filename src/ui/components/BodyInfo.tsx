import type { InfoView } from '../../game/hud/types';
import { Heading, Row } from './primitives';

/** Target details (I, in place of the controls list): physical data, the target's own orbit, and the ship relative to it. */
export function BodyInfo({ info }: { info: InfoView }) {
  return (
    <section id="info" className="pan">
      <Heading right="I HIDES">{info.title.toUpperCase()}</Heading>
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
    </section>
  );
}
