import { MagnifyingGlass, Power } from '@phosphor-icons/react';
import type { RadarView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

interface Actions {
  toggle: () => void;
  pick: (key: string, scan: boolean) => void;
}

const SCOPE = 200;

/**
 * Radar (Shift+Y): a top-down scope (nose up, log distance rings) and the contacts, nearest first.
 * A contact reads "Unidentified <class>" until the scanner (Y) identifies it: click a row to
 * target it, or "scan" to target it and start scanning.
 */
export function RadarPanel({ v, act }: { v: RadarView; act: Actions }) {
  const c = SCOPE / 2,
    R = SCOPE / 2 - 6;
  return (
    <Panel name="radar" id="radar" className="pan" title="RADAR" right="⇧Y HIDES">
      <div className="rdhead">
        <span>
          {v.range} · {v.power}
        </span>
        <button type="button" className={cx('obtn', v.on && 'cur')} onClick={act.toggle}>
          <Power weight="bold" /> {v.on ? 'on' : 'off'}
        </button>
      </div>
      <svg className="rdscope" viewBox={`0 0 ${SCOPE} ${SCOPE}`} role="img" aria-label="Radar scope">
        {v.rings.map((r) => (
          <g key={r.label}>
            <circle cx={c} cy={c} r={Math.max(2, r.r * R)} className="rdring" />
            <text x={c + 2} y={c - r.r * R - 2} className="rdlab">
              {r.label}
            </text>
          </g>
        ))}
        <line x1={c} y1={c - R} x2={c} y2={c + R} className="rdaxis" />
        <line x1={c - R} y1={c} x2={c + R} y2={c} className="rdaxis" />
        <path d={`M${c} ${c - 6} L${c - 4} ${c + 4} L${c + 4} ${c + 4} Z`} className="rdship" />
        {v.on &&
          v.contacts.map((k) => (
            <circle
              key={k.key}
              cx={c + k.x * R}
              cy={c + k.y * R}
              r={k.targeted ? 4 : 2.6}
              className={cx('rddot', k.cls.replace(' ', '-'), k.targeted && 'tgt', !k.above && 'below')}
              onClick={() => act.pick(k.key, false)}
            >
              <title>{`${k.label} · ${k.dist}`}</title>
            </circle>
          ))}
      </svg>
      {!v.on && <div className="ohint">Radar off · switch it on to see what's around (150 kW)</div>}
      <div className="rdlist">
        {v.contacts.map((k) => (
          <div key={k.key} className={cx('rdrow', k.targeted && 'tgt')}>
            <button type="button" className="rdname" onClick={() => act.pick(k.key, false)} title="Target it">
              <i className={cx('rdkind', k.cls.replace(' ', '-'))} />
              <span className={cx(!k.scanned && 'unk')}>{k.label}</span>
            </button>
            <span className="rddist">{k.dist}</span>
            {k.scanned ? (
              <span className="rdok">✓</span>
            ) : (
              <button type="button" className="obtn" onClick={() => act.pick(k.key, true)} disabled={k.scanning}>
                <MagnifyingGlass weight="bold" /> {k.scanning ? 'scanning' : 'scan'}
              </button>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
