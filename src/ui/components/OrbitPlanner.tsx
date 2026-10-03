import type { PlannerView } from '../../game/hud/types';
import type { OrbitType } from '../../game/types';
import { Panel, Row, cx } from './primitives';

const TYPES: [OrbitType, string][] = [
  ['equatorial', 'Equatorial'],
  ['polar', 'Polar'],
  ['sync', 'Stationary'],
  ['hold', 'Hold position'],
  ['ring', 'Ring'],
  ['lagrange', 'L-point'],
];

/** Orbit planner (O): choose an orbit type and altitude for the autopilot. */
export function OrbitPlanner({ p }: { p: PlannerView }) {
  return (
    <Panel name="orbit" id="orbit" className="pan" title="ORBIT PLANNER" right="O CLOSES">
      <div className="apstate">{p.unit}</div>
      <Row label="BODY" value={p.body} />
      <div className="otypes">
        {TYPES.map(([t, label], i) => (
          <div key={t} className={cx(p.type === t && 'on', !p.types.includes(t) && 'na')} title={p.types.includes(t) ? undefined : `${p.unit} can't fly this`}>
            <kbd>{i + 1}</kbd>
            {label}
          </div>
        ))}
      </div>
      <Row label={p.type === 'lagrange' ? 'POINT' : 'ALTITUDE'} value={p.alt} />
      <Row label="PERIOD" value={p.period} />
      <Row label="ORBITAL SPEED" value={p.speed} />
      <Row label="DIRECTION" value={p.dir} />
      <p className={cx('onote', p.note.warn && 'bad')}>{p.note.text}</p>
      <div className="okeys">
        {p.type === 'lagrange' ? (
          <>
            <kbd>R</kbd> next point (L1–L5) · <kbd>L</kbd> preview · <kbd>Enter</kbd> engage
          </>
        ) : (
          <>
            <kbd>[ ]</kbd> or wheel altitude · <kbd>Shift</kbd> big steps · <kbd>R</kbd> direction · <kbd>L</kbd> preview ring · <kbd>Enter</kbd> engage
          </>
        )}
      </div>
    </Panel>
  );
}
