import type { HudSnapshot } from '../../game/hud/types';
import { cx } from './primitives';

/** Short status message above the HUD; fades out on its own. */
export function Toast({ toast }: { toast: HudSnapshot['toast'] }) {
  return (
    <div id="msg" className={cx(toast.visible && 'on', toast.kind)}>
      {toast.text}
    </div>
  );
}
