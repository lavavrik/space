import type { ComputerKind } from '../../game/avionics/catalog';
import type { AvionicsSlotView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

/**
 * Avionics (U): a table of contents for the ship's computers. Each entry shows its key, unit, what
 * it's for and what it's doing now; clicking it (with the mouse free) opens its tool, like the key.
 * Its specs follow on one line.
 */
export function AvionicsPanel({ slots, onOpen }: { slots: AvionicsSlotView[]; onOpen: (kind: ComputerKind) => void }) {
  return (
    <Panel name="avionics" id="avionics" className="pan" title="AVIONICS" right="U HIDES">
      {slots.map((s) => (
        <div key={s.kind} className={cx('avslot', s.active && 'busy')}>
          <button type="button" className="aventry" onClick={() => onOpen(s.id)} disabled={s.unit === 'none fitted'}>
            <kbd>{s.key}</kbd>
            <span className="avtext">
              <span className="avkind">{s.kind}</span>
              <span className="avunit">{s.unit}</span>
              <span className="avdoes">{s.does}</span>
              <span className={cx('avstatus', s.status.warn && 'warnc')}>{s.status.text}</span>
            </span>
          </button>
          {s.specs.length > 0 && <div className="avspecs">{s.specs.map(([, v]) => v).join(' · ')}</div>}
        </div>
      ))}
      <div className="okeys">Click an entry (mouse free: Esc) or press its key</div>
    </Panel>
  );
}
