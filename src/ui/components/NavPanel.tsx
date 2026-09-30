import type { NavView } from '../../game/hud/types';
import { useState } from 'react';
import { Panel, cx } from './primitives';

export interface NavActions {
  onEngage: () => void;
  onCancel: () => void;
  onQuery: (q: string) => void;
  onSort: (from: 'ship' | 'last') => void;
  onAdd: (key: string) => void;
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
          <SearchBox n={n} a={a} />
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

const KIND_ICON = { star: '★', sun: '☀', planet: '◯', moon: '◦', station: '▢' } as const;

/**
 * Search with a dropdown: stars, planets, moons and stations. The dropdown opens under the field
 * as soon as it has focus (listing what's nearest until you type); ↑ / ↓ move the highlight, Enter adds it, Esc closes. Sorting
 * (from the ship or the last stop) sits in the dropdown's header.
 */
function SearchBox({ n, a }: { n: NavView; a: NavActions }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const sel = Math.min(hi, Math.max(0, n.results.length - 1));
  const pick = (key: string) => {
    a.onAdd(key);
    a.onQuery('');
    setHi(0);
  };
  return (
    <div className="navsearch">
      <input
        id="navsearch"
        type="search"
        placeholder="Search stars, planets, stations… ( / )"
        value={n.query}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          a.onQuery(e.target.value);
          setHi(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setHi(Math.min(sel + 1, n.results.length - 1));
          else if (e.key === 'ArrowUp') setHi(Math.max(sel - 1, 0));
          else if (e.key === 'Enter' && n.results[sel]) pick(n.results[sel].key);
          else if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          else return;
          e.preventDefault();
        }}
      />
      {open && (
        <div className="navdrop">
          <div className="navsort">
            nearest to
            <button type="button" className={cx(n.sortFrom === 'ship' && 'on')} onMouseDown={(e) => e.preventDefault()} onClick={() => a.onSort('ship')}>
              ship
            </button>
            <button type="button" className={cx(n.sortFrom === 'last' && 'on')} onMouseDown={(e) => e.preventDefault()} onClick={() => a.onSort('last')} disabled={!n.points.length}>
              last stop
            </button>
          </div>
          {n.results.length ? (
            <ul className="navres">
              {n.results.map((r, i) => (
                <li key={r.key}>
                  <button type="button" className={cx(i === sel && 'hi')} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setHi(i)} onClick={() => pick(r.key)}>
                    <i className={cx('ico', r.kind)}>{KIND_ICON[r.kind]}</i>
                    <span className="nm">{r.name}</span>
                    <span className="d">{r.detail}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="okeys">{n.query ? `Nothing matching "${n.query}" nearby` : 'Nothing nearby'}</div>
          )}
        </div>
      )}
    </div>
  );
}
