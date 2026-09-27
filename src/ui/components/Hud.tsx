import type { FlightView, LocationView, SystemsView, TargetView } from '../../game/hud/types';
import { Bar, Panel, cx } from './primitives';

/**
 * The cockpit HUD: a location line (top left) and, along the bottom, ship gauges (left), the
 * flight cluster (centre) and the target card (right). Everything scales with the window via the
 * root font size (see theme.css). Detail lives elsewhere: I opens target info, ` performance.
 */

/** Top left: system, star, galactic position and clock, and the jump destination. */
export function Location({ loc }: { loc: LocationView }) {
  return (
    <div id="loc">
      <div className="lsys">{loc.system.toUpperCase()}</div>
      <div className="lstar">{loc.star}</div>
      <div className="lsub">{loc.sub}</div>
      <div className={cx('ljump', !loc.jump.text.startsWith('JUMP') && 'hint')}>{loc.jump.text}</div>
    </div>
  );
}

/** Bottom left: three gauges with one line of detail each, and a note when something needs attention. */
export function ShipGauges({ s }: { s: SystemsView }) {
  return (
    <Panel name="sys" id="gauges" className="pan card" title="SHIP">
      {s.gauges.map((gv) => (
        <div key={gv.label} className="gauge">
          <div className="gtop">
            <span>{gv.label}</span>
            <b>{gv.value}</b>
          </div>
          <Bar frac={gv.frac} variant={gv.variant} lowWarn />
          <div className={cx('gsubl', gv.sub.warn && 'warnc')}>{gv.sub.text}</div>
        </div>
      ))}
      {s.note && <div className={cx('gnote', s.note.warn && 'warnc')}>{s.note.text}</div>}
    </Panel>
  );
}

/** Bottom centre: mode, speed, speed-limit or throttle bar, altitude and orbit, status pills. Never collapses. */
export function FlightCluster({ f }: { f: FlightView }) {
  return (
    <section id="flight" className="pan">
      <div id="hMode" className={f.modeClass}>
        {f.mode}
      </div>
      <div className="spd">{f.speed}</div>
      <div className="unit">{f.unit}</div>
      <Bar frac={f.barFrac} variant={f.barFtl ? 'ftl' : undefined} />
      <div className="barcap">
        <span>{f.barLabel}</span>
        <span>{f.barValue}</span>
      </div>
      {f.alt && <div className={cx('fline', f.alt.warn && 'warnc')}>{f.alt.text}</div>}
      {f.orbit && <div className={cx('fline', f.orbit.warn && 'warnc')}>{f.orbit.text}</div>}
      <div className="pills">
        {f.pills.map((p) => (
          <span key={p.text} className={cx('pill', p.kind)}>
            {p.text}
          </span>
        ))}
      </div>
    </section>
  );
}

/** Bottom right: the target's name, type, distance and ETA. */
export function TargetCard({ t }: { t: TargetView }) {
  return (
    <Panel name="target" id="target" className={cx('pan card', t.none && 'none')} title="TARGET">
      <div className="tname">{t.name}</div>
      <div className="ttype">{t.type}</div>
      {!t.none && (
        <div className="tdist">
          <b>{t.distance}</b>
          <span>{t.eta}</span>
        </div>
      )}
      {t.scan && (
        <>
          <div className={cx('tscan', t.scan.warn && 'warnc')}>{t.scan.text}</div>
          {t.scanFrac > 0 && <Bar frac={t.scanFrac} variant="ftl" />}
        </>
      )}
    </Panel>
  );
}
