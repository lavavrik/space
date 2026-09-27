import type { NavView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

export interface NavActions {
  onEngage: () => void;
  onCancel: () => void;
  onQuery: (q: string) => void;
  onSort: (from: 'ship' | 'last') => void;
  onAdd: (id: string) => void;
  onRemoveLast: () => void;
}

/**
 * Navigation computer (M): waypoints (click a star, or search: / focuses the box), route mode,
 * the legs with their costs, and engage/cancel. While a route is flown the panel stays up as its
 * status; cancelling takes a confirmation.
 */
export function NavPanel({ n, a }: { n: NavView; a: NavActions }) {
  return (
    <Panel name="nav" id="navpanel" className="pan" title="NAVIGATION" right={n.running ? 'ROUTE ACTIVE' : 'M CLOSES'}>
      <div className="apstate">{n.unit}</div>
      <div className="apsub">{n.dest}</div>
      {!n.running && (
        <>
          {n.points.length > 0 && (
            <div className="navpts">
              {n.points.map((p, i) => (
                <span key={i}>
                  <b>{i + 1}</b> {p}
                </span>
              ))}
              <button type="button" className="apbtn small" onClick={a.onRemoveLast}>
                <kbd>⌫</kbd> Remove last
              </button>
            </div>
          )}
          <div className="navsearch">
            <input
              id="navsearch"
              type="search"
              placeholder="Search stars… ( / )"
              value={n.query}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => a.onQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && n.results[0]) a.onAdd(n.results[0].id);
                if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
              }}
            />
            <div className="navsort">
              sorted from
              <button type="button" className={cx(n.sortFrom === 'ship' && 'on')} onClick={() => a.onSort('ship')}>
                ship
              </button>
              <button type="button" className={cx(n.sortFrom === 'last' && 'on')} onClick={() => a.onSort('last')} disabled={!n.points.length}>
                last point
              </button>
            </div>
            {n.results.length > 0 && (
              <ul className="navres">
                {n.results.map((r) => (
                  <li key={r.id}>
                    <button type="button" onClick={() => a.onAdd(r.id)}>
                      <span>{r.name}</span>
                      <span className="d">
                        {r.spec} · {r.dist}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {n.query && !n.results.length && <div className="okeys">No stars matching "{n.query}" within 100 ly</div>}
          </div>
        </>
      )}
      {n.modes && !n.running && (
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
          <button type="button" className="apbtn" onClick={a.onEngage} disabled={!n.legs.length}>
            <kbd>Enter</kbd> Engage route
          </button>
        ) : (
          <button type="button" className={cx('apbtn', 'danger', n.confirm && 'armed')} onClick={a.onCancel}>
            <kbd>⌫</kbd> {n.confirm ? 'Confirm cancel' : 'Cancel route'}
          </button>
        )}
      </div>
    </Panel>
  );
}
