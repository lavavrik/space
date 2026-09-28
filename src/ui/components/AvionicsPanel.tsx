import type { Switchable } from '../../game/sim/power';
import type { ComputerKind } from '../../game/avionics/catalog';
import type { AvionicsSlotView, ElectricalView } from '../../game/hud/types';
import { ElectricalSchematic } from './ElectricalSchematic';
import { AVIONICS_ICONS, MODULE_ICONS } from './icons';
import { Panel, Row, cx } from './primitives';

/**
 * Ship stats (U). Avionics as a 2 × 2 grid of tiles, one per computer (and the outfit): icon, key,
 * kind, model and what it's doing now; the full unit name, what it's for and its specs are in the
 * tile's tooltip. Clicking a tile (or pressing its key) opens its tool. Below: the electrical
 * schematic, which gets the room the tiles save.
 */
export function AvionicsPanel({ slots, electrical, onOpen, onToggle }: { slots: AvionicsSlotView[]; electrical: ElectricalView | null; onOpen: (kind: ComputerKind | 'outfit') => void; onToggle: (id: Switchable) => void }) {
  return (
    <Panel name="avionics" id="avionics" className="pan" title="SHIP" right="U HIDES">
      <div className="isec first">AVIONICS</div>
      <div className="avgrid">
        {slots.map((s) => {
          const I = AVIONICS_ICONS[s.id];
          const tip = [s.unit, s.maker, s.does, s.blurb, ...s.specs.map(([, v]) => v)].filter(Boolean).join('\n');
          return (
            <button key={s.kind} type="button" className={cx('avtile', s.active && 'busy')} title={tip} onClick={() => onOpen(s.id)} disabled={s.unit === 'none fitted'}>
              <span className="avicon">
                <I weight="duotone" />
              </span>
              <span className="avtext">
                <span className="avkind">
                  {s.kind}
                  <kbd>{s.key}</kbd>
                </span>
                <span className="avunit">{s.model}</span>
                {s.mods ? (
                  <span className="avmods">
                    {s.mods.map((m, i) => {
                      const M = MODULE_ICONS[m.icon];
                      return (
                        <span key={i} className={cx('avmod', m.icon === 'empty' && 'empty')} title={m.title}>
                          <M weight="bold" />
                        </span>
                      );
                    })}
                  </span>
                ) : (
                  <span className={cx('avstatus', s.status.warn && 'warnc')}>{s.status.text}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {electrical && (
        <>
          <div className="isec">ELECTRICAL</div>
          <ElectricalSchematic e={electrical} onToggle={onToggle} />
          {electrical.rows.map(([k, v]) => (
            <Row key={k} label={k} value={v} />
          ))}
        </>
      )}
    </Panel>
  );
}
