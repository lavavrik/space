import type { PlannerView } from '../../game/hud/types';
import type { OrbitType } from '../../game/types';
import { Heading, Row, cx } from './primitives';

const TYPES: [OrbitType, string][] = [
  ['equatorial', 'Equatorial'],
  ['polar', 'Polar'],
  ['sync', 'Stationary'],
  ['hold', 'Hold position'],
];

/** Orbit planner (O): choose an orbit type and altitude for the autopilot. */
export function OrbitPlanner({ p }: { p: PlannerView }) {
  return (
    <div id="orbit" className="pan">
      <Heading right="O CLOSES">ORBIT PLANNER</Heading>
      <Row label="BODY" value={p.body} />
      <div className="otypes">
        {TYPES.map(([t, label], i) => (
          <div key={t} className={cx(p.type === t && 'on')}>
            <kbd>{i + 1}</kbd>
            {label}
          </div>
        ))}
      </div>
      <Row label="ALTITUDE" value={p.alt} />
      <Row label="PERIOD" value={p.period} />
      <Row label="ORBITAL SPEED" value={p.speed} />
      <Row label="DIRECTION" value={p.dir} />
      <p className={cx('onote', p.note.warn && 'bad')}>{p.note.text}</p>
      <div className="okeys">
        <kbd>[ ]</kbd> or wheel altitude · <kbd>Shift</kbd> big steps · <kbd>R</kbd> direction · <kbd>Enter</kbd> engage
      </div>
    </div>
  );
}
