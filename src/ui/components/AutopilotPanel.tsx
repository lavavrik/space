import type { AutopilotView } from '../../game/hud/types';
import { Panel, Row, cx } from './primitives';

/**
 * Autopilot status (O while it flies): what it's flying, the target versus the current orbit, how
 * far off you are, and the only way to hand back control, which takes a confirmation. The buttons
 * work with the mouse free (Esc releases it); Backspace ×2 and Enter do the same from the keyboard.
 */
export function AutopilotPanel({ a, onDisengage, onChange, onRelease }: { a: AutopilotView; onDisengage: () => void; onChange: () => void; onRelease: (b: 'planet' | 'away') => void }) {
  return (
    <Panel name="autopilot" id="apstat" className="pan" title="AUTOPILOT" right="O CLOSES">
      <div className="apstate">{a.unit}</div>
      <div className="apsub">
        {a.title} · {a.sub}
      </div>
      <div className="apstate">{a.state.text}</div>
      {a.rows.map(([k, v]) => (
        <Row key={k} label={k} value={v} />
      ))}
      {a.release && (
        <>
          <div className="apbtns">
            <button type="button" className="apbtn" onClick={() => onRelease('planet')}>
              <kbd>[</kbd> Release toward planet
            </button>
            <button type="button" className="apbtn" onClick={() => onRelease('away')}>
              <kbd>]</kbd> Release away
            </button>
          </div>
          <p className="onote">{a.release}</p>
        </>
      )}
      <div className="apbtns">
        <button type="button" className="apbtn" onClick={onChange}>
          <kbd>Enter</kbd> Change orbit
        </button>
        <button type="button" className={cx('apbtn', 'danger', a.confirm && 'armed')} onClick={onDisengage}>
          <kbd>⌫</kbd> {a.confirm ? 'Confirm disengage' : 'Disengage'}
        </button>
      </div>
      {a.confirm && <p className="onote bad">Press Backspace again (or Confirm) within 3 s to hand back manual control.</p>}
    </Panel>
  );
}
