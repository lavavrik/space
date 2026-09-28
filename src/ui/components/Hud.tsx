import {
  Anchor, ArrowsOutCardinal, BatteryWarning, Binoculars, Broadcast, Fan, Funnel, Gauge, Headlights, Hourglass, Lightning,
  LightningSlash, Lock, PlugsConnected, ShieldCheck, SolarPanel, Snowflake, SteeringWheel, Sun, ThermometerHot, Wind, type Icon,
} from '@phosphor-icons/react';
import type { FlightView, GaugeBadge as GaugeBadgeView, Lamp, LampId, LocationView, SystemsView, TargetView } from '../../game/hud/types';
import { Bar, Panel, cx } from './primitives';
import { Tip } from './Tooltip';

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

/** Phosphor icons (MIT) for the gauge badges. */
const BADGE_ICONS: Record<GaugeBadgeView['icon'], Icon> = { 'panels-off': SolarPanel, vent: Wind, radiators: Snowflake, pump: Fan };

/** Small status icon beside a gauge label, with its explanation as a tooltip. */
function GaugeBadge({ icon, title, warn }: GaugeBadgeView) {
  const I = BADGE_ICONS[icon];
  return (
    <Tip className={cx('gbadge', warn && 'warnc')} content={<div className="tipd">{title}</div>}>
      <I weight="bold" aria-label={title} />
    </Tip>
  );
}

/** Bottom left: three gauges with one line of detail each, and a note when something needs attention. */
export function ShipGauges({ s }: { s: SystemsView }) {
  return (
    <Panel name="sys" id="gauges" className="pan card" title="SHIP">
      {s.gauges.map((gv) => (
        <div key={gv.label} className="gauge">
          <div className="gtop">
            <span>
              {gv.label}
              {gv.badges?.map((b) => <GaugeBadge key={b.icon} {...b} />)}
            </span>
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

/** Phosphor icons (MIT) for the dashboard lamps. */
const LAMP_ICONS: Record<LampId, Icon> = {
  fa: ShieldCheck, decoupled: ArrowsOutCardinal, autopilot: SteeringWheel, cruise: Gauge, dock: Anchor,
  sun: Sun, lights: Headlights, radiators: Snowflake, pump: Fan, vent: Wind, scoop: Funnel, radar: Broadcast, shore: PlugsConnected,
  charge: Lightning, masslock: Lock, hot: ThermometerHot, battery: BatteryWarning, power: LightningSlash, warp: Hourglass, zoom: Binoculars,
};

/** A lamp's tooltip: name, on/off, its key, and a line of live detail. */
function LampTip({ l }: { l: Lamp }) {
  return (
    <>
      <div className="tiph">
        <span className="tipn">{l.name}</span>
        <span className={cx('tips', l.state)}>{l.state === 'off' ? 'OFF' : l.state === 'warn' ? 'WARN' : 'ON'}</span>
        {l.key && <kbd>{l.key}</kbd>}
      </div>
      {l.detail && <div className="tipd">{l.detail}</div>}
    </>
  );
}

/** Above the speedometer: a row of tell-tales, dim when off and lit when on (hud/types.ts, Lamp). */
export function Lamps({ lamps }: { lamps: Lamp[] }) {
  return (
    <div id="lamps">
      {lamps.map((l) => {
        const I = LAMP_ICONS[l.id];
        return (
          <Tip key={l.id} className={cx('lamp', l.state, l.blink && 'blink')} content={<LampTip l={l} />}>
            <I weight={l.state === 'off' ? 'regular' : 'fill'} aria-label={l.name} />
          </Tip>
        );
      })}
    </div>
  );
}

/** Bottom centre: dashboard lamps, mode, speed, speed-limit or throttle bar, altitude and orbit, status pills. Never collapses. */
export function FlightCluster({ f, lamps }: { f: FlightView; lamps: Lamp[] }) {
  return (
    <section id="flight" className="pan">
      <Lamps lamps={lamps} />
      <div id="hMode" className={f.modeClass}>
        {f.mode}
      </div>
      <div className="spd">{f.speed}</div>
      <div className="unit">{f.unit}</div>
      <Bar frac={f.barFrac} variant={f.barFtl ? 'ftl' : undefined} mark={f.barMark} />
      <div className="barcap">
        <span className={cx(f.barHi === 'left' && 'hi')}>{f.barLabel}</span>
        <span className={cx(f.barHi === 'right' && 'hi')}>{f.barValue}</span>
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
