import { Crosshair, MagnifyingGlass } from '@phosphor-icons/react';
import type { RadarView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

interface Actions {
  sweep: () => void;
  pick: (key: string, scan: boolean) => void;
}

const SCOPE = 200;

/**
 * Radar (Shift+Y): "scan" runs a sweep (sim/radar.ts); a fixed top-down scope (nose up, log
 * distance rings, a sweep line while it runs) above a scrolling list of what it has found, nearest
 * first. A contact reads "Unidentified <class>" until the scanner identifies it: click a row to
 * target it, or "identify" to target it and start the scanner (Y).
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
        <button type="button" className="obtn" onClick={act.sweep} disabled={v.sweeping > 0}>
          <Crosshair weight="bold" /> {v.sweeping > 0 ? `sweeping ${Math.round(v.sweeping * 100)} %` : 'scan'}
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
        {v.sweeping > 0 && (
          <line
            x1={c}
            y1={c}
            x2={c + Math.sin(v.sweeping * Math.PI * 6) * R}
            y2={c - Math.cos(v.sweeping * Math.PI * 6) * R}
            className="rdbeam"
          />
        )}
        {v.contacts.map((k) => (
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
      {v.contacts.length === 0 && v.sweeping === 0 && <div className="ohint">Nothing tracked here yet · scan to sweep 10 AU (400 kW for 4 s)</div>}
      {v.prospects.length > 0 && (
        <div className="rdpros">
          <div className="sub">
            <span>METAL-RICH ROCKS · MARKED IN VIEW</span>
          </div>
          {v.prospects.map((p) => (
            <div key={p.n} className="rdprow">
              <i className={cx('rdkind', `pr-${p.kind}`)} />
              <span>
                {p.n} · {p.kind} {p.size}
              </span>
              <span className="rddist">{p.dist}</span>
              <span className="rdworth">{p.worth}</span>
            </div>
          ))}
        </div>
      )}
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
                <MagnifyingGlass weight="bold" /> {k.scanning ? 'identifying' : 'identify'}
              </button>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
