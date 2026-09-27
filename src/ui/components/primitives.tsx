import { useCallback, useState, type ReactNode } from 'react';
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

/** Panel heading with an optional right-hand label. With `onToggle`, clicking it collapses the panel. */
export function Heading({ children, right, collapsed, onToggle }: { children: ReactNode; right?: ReactNode; collapsed?: boolean; onToggle?: () => void }) {
  return (
    <div className={cx('h', onToggle && 'toggle')} onClick={onToggle} title={onToggle ? (collapsed ? 'Expand' : 'Collapse') : undefined}>
      <span>
        {onToggle && <i className="caret">{collapsed ? '▸' : '▾'}</i>}
        {children}
      </span>
      <span>{right}</span>
    </div>
  );
}

const STORE_KEY = 'farlight.collapsed';

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Whether panel `name` is collapsed, remembered per browser (storage may be unavailable; then it just resets). */
export function useCollapsed(name: string): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => !!readCollapsed()[name]);
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ ...readCollapsed(), [name]: !c }));
      } catch {
        // private mode or blocked storage: collapse still works for this session
      }
      return !c;
    });
  }, [name]);
  return [collapsed, toggle];
}

/**
 * A HUD window whose heading collapses it to just that heading. `name` keys the remembered state.
 */
export function Panel({ name, id, className, title, right, children }: { name: string; id?: string; className?: string; title: ReactNode; right?: ReactNode; children: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(name);
  return (
    <section id={id} className={cx(className, collapsed && 'collapsed')}>
      <Heading right={right} collapsed={collapsed} onToggle={toggle}>
        {title}
      </Heading>
      {!collapsed && children}
    </section>
  );
}

/** Horizontal fill bar. `lowWarn` turns it red below 15 %. */
/** A fill bar. `mark` (0..1) draws a tick there and shades the track beyond it (e.g. the boost range). */
export function Bar({ frac, variant, lowWarn, mark }: { frac: number; variant?: 'ftl' | 'batt' | 'heat'; lowWarn?: boolean; mark?: number }) {
  const f = Math.max(0, Math.min(1, frac));
  const pct = (x: number) => (x * 100).toFixed(1) + '%';
  return (
    <div className={cx('bar', variant, lowWarn && frac < 0.15 && 'low', mark !== undefined && f > mark && 'over')}>
      {mark !== undefined && <s style={{ left: pct(mark) }} />}
      <i style={{ width: pct(f) }} />
      {mark !== undefined && <b style={{ left: pct(mark) }} />}
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
