import type { ReactNode } from 'react';
import type { Readout } from '../../game/hud/types';

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');
export { cx };

/** A label on the left and a monospace value on the right. */
export function Row({ label, value }: { label: string; value: string | Readout }) {
  const r = typeof value === 'string' ? { text: value } : value;
  return (
    <div className="row">
      <span>{label}</span>
      <b className={r.warn ? 'warnc' : undefined}>{r.text}</b>
    </div>
  );
}

/** Panel heading with an optional right-hand label. */
export function Heading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="h">
      <span>{children}</span>
      <span>{right}</span>
    </div>
  );
}

/** Horizontal fill bar. `lowWarn` turns it red below 15 %. */
export function Bar({ frac, variant, lowWarn }: { frac: number; variant?: 'ftl' | 'batt'; lowWarn?: boolean }) {
  const f = Math.max(0, Math.min(1, frac));
  return (
    <div className={cx('bar', variant, lowWarn && frac < 0.15 && 'low')}>
      <i style={{ width: (f * 100).toFixed(1) + '%' }} />
    </div>
  );
}

/** Small two-column caption line. */
export function Sub({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="sub">
      {left}
      {right}
    </div>
  );
}
