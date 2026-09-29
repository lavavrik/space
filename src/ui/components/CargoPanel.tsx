import type { CargoView } from '../../game/hud/types';
import { Panel, Row, cx } from './primitives';

interface Actions {
  sell: (c: CargoView['items'][number]['id']) => void;
  sellAll: () => void;
  jettison: (c: CargoView['items'][number]['id']) => void;
}

/**
 * Cargo (Shift+I): the hold as one stacked bar (a colour per metal), a line per metal with its mass,
 * price and value (at the docked station's prices, else list), and what to do with it: sell it
 * docked, jettison it in flight (twice to confirm). Below, the tanks, and what the load costs in Δv.
 */
export function CargoPanel({ v, act }: { v: CargoView; act: Actions }) {
  return (
    <Panel name="cargo" id="cargo" className="pan" title="CARGO" right="⇧I HIDES">
      <div className="sub">
        <span>HOLD</span>
        <span>{v.used}</span>
      </div>
      <div className="bar cghold">
        {v.items.map((it, i) => {
          const left = v.items.slice(0, i).reduce((a, x) => a + x.frac, 0);
          return <i key={it.id} className={`cg-${it.id}`} style={{ left: `${left * 100}%`, width: `${it.frac * 100}%` }} />;
        })}
      </div>
      <div className="cglist">
        {v.items.map((it) => (
          <div key={it.id} className={cx('cgrow', it.empty && 'empty')}>
            <i className={`cgsw cg-${it.id}`} />
            <span className="cgname">{it.name}</span>
            <b>{it.empty ? '—' : it.mass}</b>
            <span className="cgprice">{it.price}</span>
            <b>{it.empty ? '' : it.value}</b>
            {!it.empty &&
              (v.docked ? (
                <button type="button" className="obtn" onClick={() => act.sell(it.id)}>
                  sell
                </button>
              ) : (
                <button type="button" className={cx('obtn', v.armed === it.id && 'warn')} onClick={() => act.jettison(it.id)}>
                  {v.armed === it.id ? 'dump it?' : 'jettison'}
                </button>
              ))}
          </div>
        ))}
      </div>
      <div className="sub">
        <span>WORTH {v.where.toUpperCase()}</span>
        <span>{v.total}</span>
      </div>
      {v.docked && v.frac > 0 && (
        <div className="obtns">
          <button type="button" className="obtn" onClick={act.sellAll}>
            sell the hold · {v.total}
          </button>
        </div>
      )}
      {v.mining && <div className="ohint">{v.mining}</div>}
      {!v.docked && v.frac === 0 && !v.mining && <div className="ohint">Empty · mine ring rocks with the laser (⇧M) and sell the metal at any station</div>}
      <div className="sep" />
      {v.tanks.map((t) => (
        <div key={t.name} className="gauge">
          <div className="sub">
            <span>{t.name.toUpperCase()}</span>
            <span>{t.value}</span>
          </div>
          <div className={cx('bar', t.kind === 'exotic' && 'ftl')}>
            <i style={{ width: `${Math.min(1, t.frac) * 100}%` }} />
          </div>
        </div>
      ))}
      <div className="sep" />
      <Row label="Ship mass" value={v.mass} />
      <Row label="Δv left" value={v.dv} />
      <Row label="Credits" value={v.credits} />
    </Panel>
  );
}
