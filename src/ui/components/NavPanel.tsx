import type { NavView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

/**
 * Navigation computer (M): destination, route mode, the legs with their costs, and engage/cancel.
 * While a route is flown the panel stays up as its status; cancelling takes a confirmation.
 */
export function NavPanel({ n, onEngage, onCancel }: { n: NavView; onEngage: () => void; onCancel: () => void }) {
  return (
    <Panel name="nav" id="navpanel" className="pan" title="NAVIGATION" right={n.running ? 'ROUTE ACTIVE' : 'M CLOSES'}>
      <div className="apstate">{n.unit}</div>
      <div className="apsub">{n.dest}</div>
      {n.modes && (
        <div className="otypes">
          {n.modes.map((m, i) => (
            <div key={m.label} className={cx(m.on && 'on')}>
              <kbd>{i + 1}</kbd>
              {m.label}
            </div>
          ))}
        </div>
      )}
      <ol className="navlegs">
        {n.legs.map((l, i) => (
          <li key={i} className={l.state}>
            <span className="t">{l.text}</span>
            <span className="d">{l.detail}</span>
          </li>
        ))}
      </ol>
      {n.totals && <div className="navtot">{n.totals}</div>}
      {n.running && n.status && <div className="navstat">{n.status}</div>}
      {n.warning && <p className="onote bad">{n.warning.text}</p>}
      {n.hint && <div className="okeys">{n.hint}</div>}
      <div className="apbtns">
        {!n.running ? (
          <button type="button" className="apbtn" onClick={onEngage} disabled={!n.legs.length}>
            <kbd>Enter</kbd> Engage route
          </button>
        ) : (
          <button type="button" className={cx('apbtn', 'danger', n.confirm && 'armed')} onClick={onCancel}>
            <kbd>⌫</kbd> {n.confirm ? 'Confirm cancel' : 'Cancel route'}
          </button>
        )}
      </div>
    </Panel>
  );
}
