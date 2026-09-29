import type { ElectricalView } from '../../game/hud/types';
import type { Switchable } from '../../game/sim/power';
import { fmtEnergy, fmtPower } from '../../game/format';
import { cx } from './primitives';

/*
 * The power bus as a schematic: the solar panels, external (station) power, the battery and a fuel cell (if fitted) on the
 * left feed a vertical bus bar, which feeds every load on the right. A wire carrying power is drawn solid and thicker with
 * more power, with dashes marching the way the power flows (into the battery when it's charging);
 * an idle wire is faint. A load getting less than it asks for is red, with its share. Loads that
 * can be switched off have a switch at their right edge (sim/power.ts); switched off, the box dims.
 */

const W = 360,
  MIN_H = 330;
/** Source boxes end at SRC_R; the bus sits midway between them and the loads, so wires match both sides. */
const SRC_R = 122,
  BUS_X = 160;
const LOAD_X = 2 * BUS_X - SRC_R,
  LOAD_W = W - LOAD_X - 4,
  LOAD_H = 34,
  LOAD_GAP = 42,
  LOAD_Y0 = 12;

/** Wire thickness for a power (kW): 1.2 px idle up to ~5 px at tens of MW. */
const thick = (kw: number) => (kw < 0.5 ? 1 : 1.4 + Math.min(3.6, Math.log10(1 + kw / 50) * 1.6));

function Wire({ d, kw, rev, lim }: { d: string; kw: number; rev?: boolean; lim?: boolean }) {
  const on = kw >= 0.5;
  return <path d={d} className={cx('ew', on && 'on', rev && 'rev', lim && 'lim')} strokeWidth={thick(kw)} />;
}

/** A power switch: a slider, knob right and lit when on. */
function Switch({ x, y, on, name, onToggle }: { x: number; y: number; on: boolean; name: string; onToggle: () => void }) {
  return (
    <g className={cx('esw', on && 'on')} onClick={onToggle} role="switch" aria-checked={on} aria-label={name}>
      <rect x={x - 4} y={y - 6} width={30} height={24} className="eswhit" />
      <rect x={x} y={y} width={22} height={12} rx={6} className="eswtrack" />
      <circle cx={on ? x + 16 : x + 6} cy={y + 6} r={4} className="eswknob" />
    </g>
  );
}

export function ElectricalSchematic({ e, onToggle }: { e: ElectricalView; onToggle: (id: Switchable) => void }) {
  const { solar, shore, battery, fuelcell, bus, loads } = e;
  const H = Math.max(MIN_H, LOAD_Y0 + (loads.length - 1) * LOAD_GAP + LOAD_H + 22);
  const busTop = LOAD_Y0 + LOAD_H / 2,
    busBot = LOAD_Y0 + (loads.length - 1) * LOAD_GAP + LOAD_H / 2;
  const solarY = 12,
    shoreY = 88,
    battY = 156,
    fcY = 248;
  const solarMid = solarY + 28,
    shoreMid = shoreY + 22,
    battMid = battY + 40,
    fcMid = fcY + 28;
  const charging = battery.flowKW > 0.5,
    discharging = battery.flowKW < -0.5;
  const battFrac = Math.max(0, Math.min(1, battery.kwh / battery.cap));
  const solarNote = { ok: `max ${fmtPower(solar.max)}`, dark: 'panels off the star', shadow: 'in shadow', feathered: 'feathered · too hot', inside: 'inside the station' }[solar.state];
  return (
    <svg className="esch" viewBox={`0 0 ${W} ${H}`} style={{ aspectRatio: `${W} / ${H}` }} role="img" aria-label="Power schematic">
      {/* bus bar */}
      <line x1={BUS_X} y1={Math.min(busTop, solarMid)} x2={BUS_X} y2={Math.max(busBot, fuelcell ? fcMid : battMid)} className="ebus" />
      <text x={BUS_X} y={H - 4} className="elab mid">
        BUS {fmtPower(bus.drawKW)} / {fmtPower(bus.capKW)}
        {solar.curtailed > 1 && ` · ${fmtPower(solar.curtailed)} unused`}
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

      {/* external power: the station's supply while docked */}
      <Wire d={`M${SRC_R} ${shoreMid} H${BUS_X}`} kw={shore.kw} />
      <g className={cx('ebox', !shore.source && 'off')}>
        <rect x={4} y={shoreY} width={SRC_R - 4} height={44} />
        <text x={12} y={shoreY + 15} className="etitle">
          EXTERNAL POWER
        </text>
        <text x={12} y={shoreY + 33} className="eval">
          {shore.source ? fmtPower(shore.kw) : 'not connected'}
        </text>
      </g>

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
          {fmtEnergy(battery.kwh)} / {fmtEnergy(battery.cap)}
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

      {/* the fuel cell (sim/oxygen.ts): a reserve source, burning H₂ with O₂ while the battery is low */}
      {fuelcell && (
        <>
          <Wire d={`M${SRC_R} ${fcMid} H${BUS_X}`} kw={fuelcell.kw} />
          <g className={cx('ebox', fuelcell.kw < 0.5 && 'off', !fuelcell.on && 'dead')}>
            <rect x={4} y={fcY} width={SRC_R - 4} height={56} />
            <text x={12} y={fcY + 16} className="etitle">
              FUEL CELL
            </text>
            <text x={12} y={fcY + 34} className="eval">
              {!fuelcell.on ? 'switched off' : fuelcell.running ? fmtPower(fuelcell.kw) : 'standby'}
            </text>
            <text x={12} y={fcY + 48} className="esub">
              {fuelcell.running ? `${fuelcell.h2.toFixed(1)} kg H₂ · ${fuelcell.o2.toFixed(0)} kg O₂ /h` : `${fmtPower(fuelcell.max)} · starts < 30 %`}
            </text>
          </g>
          <Switch x={SRC_R - 32} y={fcY + 6} on={fuelcell.on} name="Fuel cell" onToggle={() => onToggle('fuelcell')} />
        </>
      )}

      {/* loads */}
      {loads.map((l, i) => {
        const y = LOAD_Y0 + i * LOAD_GAP;
        const lim = l.limited !== null;
        return (
          <g key={l.id}>
            <Wire d={`M${BUS_X} ${y + LOAD_H / 2} H${LOAD_X}`} kw={l.kw} lim={lim} />
            <g className={cx('ebox', l.kw < 0.5 && 'off', !l.on && 'dead', lim && 'warn')}>
              <rect x={LOAD_X} y={y} width={LOAD_W} height={LOAD_H} />
              <text x={LOAD_X + 8} y={y + 13} className="etitle">
                {l.name}
              </text>
              <text x={LOAD_X + 8} y={y + 28} className="eval">
                {!l.on ? 'switched off' : l.kw < 0.5 ? 'idle' : fmtPower(l.kw)}
                {lim && ` · ${Math.round(l.limited! * 100)} %`}
              </text>
            </g>
            {l.sw && <Switch x={LOAD_X + LOAD_W - 30} y={y + LOAD_H / 2 - 6} on={l.on} name={l.name} onToggle={() => onToggle(l.sw!)} />}
          </g>
        );
      })}
    </svg>
  );
}
