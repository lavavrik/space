import type { ElectricalView } from '../../game/hud/types';
import { fmtPower } from '../../game/format';
import { cx } from './primitives';

/*
 * The power bus as a schematic: the solar panels and the battery on the left feed a vertical bus
 * bar, which feeds every load on the right. A wire carrying power is drawn solid and thicker with
 * more power, with dashes marching the way the power flows (into the battery when it's charging);
 * an idle wire is faint. A load getting less than it asks for is red, with its share.
 */

const W = 360,
  H = 280;
/** Source boxes end at SRC_R; the bus sits midway between them and the loads, so wires match both sides. */
const SRC_R = 122,
  BUS_X = 160;
const LOAD_X = 2 * BUS_X - SRC_R,
  LOAD_W = W - LOAD_X - 4,
  LOAD_H = 40,
  LOAD_GAP = 50,
  LOAD_Y0 = 12;

/** Wire thickness for a power (kW): 1.2 px idle up to ~5 px at tens of MW. */
const thick = (kw: number) => (kw < 0.5 ? 1 : 1.4 + Math.min(3.6, Math.log10(1 + kw / 50) * 1.6));

function Wire({ d, kw, rev, lim }: { d: string; kw: number; rev?: boolean; lim?: boolean }) {
  const on = kw >= 0.5;
  return <path d={d} className={cx('ew', on && 'on', rev && 'rev', lim && 'lim')} strokeWidth={thick(kw)} />;
}

export function ElectricalSchematic({ e }: { e: ElectricalView }) {
  const { solar, battery, bus, loads } = e;
  const busTop = LOAD_Y0 + LOAD_H / 2,
    busBot = LOAD_Y0 + (loads.length - 1) * LOAD_GAP + LOAD_H / 2;
  const solarY = 18,
    battY = 150;
  const solarMid = solarY + 28,
    battMid = battY + 40;
  const charging = battery.flowKW > 0.5,
    discharging = battery.flowKW < -0.5;
  const battFrac = Math.max(0, Math.min(1, battery.kwh / battery.cap));
  const solarNote = { ok: `max ${fmtPower(solar.max)}`, dark: 'panels off the star', shadow: 'in shadow', feathered: 'feathered · too hot' }[solar.state];
  return (
    <svg className="esch" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Power schematic">
      {/* bus bar */}
      <line x1={BUS_X} y1={Math.min(busTop, solarMid)} x2={BUS_X} y2={Math.max(busBot, battMid)} className="ebus" />
      <text x={BUS_X} y={H - 4} className="elab mid">
        BUS {fmtPower(bus.drawKW)} / {fmtPower(bus.capKW)}
      </text>

      {/* sources */}
      <Wire d={`M${SRC_R} ${solarMid} H${BUS_X}`} kw={solar.kw} />
      <g className={cx('ebox', solar.state !== 'ok' && 'off', solar.state === 'feathered' && 'warn')}>
        <rect x={4} y={solarY} width={SRC_R - 4} height={56} />
        <text x={12} y={solarY + 16} className="etitle">
          SOLAR PANELS
        </text>
        <text x={12} y={solarY + 34} className="eval">
          {fmtPower(solar.kw)}
        </text>
        <text x={12} y={solarY + 48} className="esub">
          {solarNote}
        </text>
      </g>
      {solar.curtailed > 1 && (
        <text x={(4 + SRC_R) / 2} y={solarY + 70} className="esub mid">
          {fmtPower(solar.curtailed)} unused
        </text>
      )}

      <Wire d={`M${SRC_R} ${battMid} H${BUS_X}`} kw={Math.abs(battery.flowKW)} rev={charging} />
      <g className={cx('ebox', battFrac < 0.15 && 'warn')}>
        <rect x={4} y={battY} width={SRC_R - 4} height={80} />
        <text x={12} y={battY + 16} className="etitle">
          BATTERY
        </text>
        <text x={12} y={battY + 30} className="esub">
          {battery.unit}
        </text>
        <text x={12} y={battY + 47} className="eval">
          {battery.kwh.toFixed(0)} / {battery.cap} kWh
        </text>
        <rect x={12} y={battY + 53} width={SRC_R - 20} height={5} className="egauge" />
        <rect x={12} y={battY + 53} width={(SRC_R - 20) * battFrac} height={5} className="egauge fill" />
        <text x={12} y={battY + 72} className="esub">
          {fmtPower(battery.maxKW)} out · {fmtPower(battery.chargeKW)} in
        </text>
      </g>
      <text x={(SRC_R + BUS_X) / 2} y={battMid - 6} className={cx('esub', 'mid', (charging || discharging) && 'flow')}>
        {charging ? '◀' : discharging ? '▶' : ''}
      </text>

      {/* loads */}
      {loads.map((l, i) => {
        const y = LOAD_Y0 + i * LOAD_GAP;
        const lim = l.limited !== null;
        return (
          <g key={l.id}>
            <Wire d={`M${BUS_X} ${y + LOAD_H / 2} H${LOAD_X}`} kw={l.kw} lim={lim} />
            <g className={cx('ebox', l.kw < 0.5 && 'off', lim && 'warn')}>
              <rect x={LOAD_X} y={y} width={LOAD_W} height={LOAD_H} />
              <text x={LOAD_X + 8} y={y + 15} className="etitle">
                {l.name}
              </text>
              <text x={LOAD_X + 8} y={y + 32} className="eval">
                {l.kw < 0.5 ? 'off' : fmtPower(l.kw)}
                {lim && ` · ${Math.round(l.limited! * 100)} %`}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
