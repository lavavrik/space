import type { InfluencesView } from '../../game/hud/types';
import { Bar, Panel, Row, cx } from './primitives';

/**
 * Influences (B), a built-in instrument: every body's gravitational pull on the ship (strongest
 * first; the one the physics applies is marked), the frames you're in, what limits the FTL drive,
 * and starlight and fuel-scoop ranges.
 */
export function InfluencesPanel({ v }: { v: InfluencesView }) {
  return (
    <Panel name="influences" id="influences" className="pan" title="INFLUENCES" right="B HIDES">
      <div className="isec">GRAVITY</div>
      {v.gravity.map((p) => (
        <div key={p.name} className={cx('infl', p.applied && 'applied')}>
          <div className="gtop">
            <span>
              {p.name}
              {p.applied && <em> · applied</em>}
            </span>
            <b>{p.value}</b>
          </div>
          <Bar frac={p.frac} variant={p.applied ? undefined : 'ftl'} />
          <div className="gsubl">{p.detail}</div>
        </div>
      ))}
      <div className="isec">FRAME</div>
      {v.frame.map(([k, val]) => (
        <Row key={k} label={k} value={val} />
      ))}
      <div className="isec">FTL</div>
      {v.ftl.map(([k, val]) => (
        <Row key={k} label={k} value={val} />
      ))}
      <div className="isec">STAR · FUEL</div>
      {v.light.map(([k, val]) => (
        <Row key={k} label={k} value={val} />
      ))}
    </Panel>
  );
}
