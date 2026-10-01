import { useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import type { Input } from '../../game/input/Input';
import type { HudSnapshot } from '../../game/hud/types';
import { cx } from './primitives';

/**
 * On-screen controls for phones and tablets. They drive the same Input the keyboard does: held
 * buttons set keys (polled each frame by the simulation), tapped ones fire key presses (the
 * handlers in game/input/controls.ts), so nothing in the simulation knows about touch. Steering is
 * a one-finger drag on the view itself and tapping targets, both in Input.
 */

/** A control: tap fires a press of `code` (with Shift when `shift`). */
interface Action {
  label: string;
  code: string;
  shift?: boolean;
}

/** Everything the "more" sheet offers, in the keyboard's groups (ui/controls.ts). */
const SHEET: { title: string; actions: Action[] }[] = [
  {
    title: 'FLIGHT',
    actions: [
      { label: 'Flight assist', code: 'KeyZ', shift: true },
      { label: 'Decouple', code: 'KeyV' },
      { label: 'Periscope', code: 'KeyZ' },
      { label: 'Sun track', code: 'KeyP' },
      { label: 'Lights', code: 'KeyL', shift: true },
      { label: 'Warp −', code: 'Comma' },
      { label: 'Warp +', code: 'Period' },
    ],
  },
  {
    title: 'FTL & NAV',
    actions: [
      { label: 'Hyperjump', code: 'KeyH' },
      { label: 'Cruise', code: 'KeyF' },
      { label: 'Pick star', code: 'KeyN' },
      { label: 'Navigation', code: 'KeyM' },
      { label: 'System map', code: 'KeyO', shift: true },
    ],
  },
  {
    title: 'TARGET',
    actions: [
      { label: 'Scan', code: 'KeyY' },
      { label: 'Pivot to', code: 'KeyT', shift: true },
      { label: 'Info', code: 'KeyI' },
      { label: 'Radar', code: 'KeyY', shift: true },
      { label: 'Names', code: 'KeyN', shift: true },
    ],
  },
  {
    title: 'SHIP',
    actions: [
      { label: 'Dock / launch', code: 'KeyK' },
      { label: 'Orbit / autopilot', code: 'KeyO' },
      { label: 'Vent H₂', code: 'KeyR' },
      { label: 'Radiators', code: 'KeyR', shift: true },
      { label: 'Mining laser', code: 'KeyM', shift: true },
      { label: 'Tanker', code: 'KeyK', shift: true },
      { label: 'Ship stats', code: 'KeyU' },
      { label: 'Outfit', code: 'KeyU', shift: true },
      { label: 'Cargo', code: 'KeyI', shift: true },
      { label: 'Jobs', code: 'KeyJ', shift: true },
      { label: 'Influences', code: 'KeyB' },
      { label: 'Sound', code: 'KeyP', shift: true },
    ],
  },
];

/** Keys the open panels want (orbit planner, navigation, autopilot): shown beside the controls while one is up. */
function panelKeys(hud: HudSnapshot): Action[] {
  const k: Action[] = [];
  if (hud.planner) {
    for (let i = 1; i <= 5; i++) k.push({ label: String(i), code: `Digit${i}` });
    k.push({ label: '[', code: 'BracketLeft' }, { label: ']', code: 'BracketRight' }, { label: 'Dir', code: 'KeyR' }, { label: 'L', code: 'KeyL' });
  } else if (hud.nav) {
    for (let i = 1; i <= 3; i++) k.push({ label: String(i), code: `Digit${i}` });
    k.push({ label: '/', code: 'Slash' });
  }
  if (hud.planner || hud.nav || hud.autopilot) k.push({ label: '⏎', code: 'Enter' }, { label: '⌫', code: 'Backspace' });
  return k;
}

/** A button that holds `code` down for as long as it's touched. */
function Hold({ input, code, className, children }: { input: Input; code: string; className?: string; children: ReactNode }) {
  const [down, setDown] = useState(false);
  const set = (d: boolean) => {
    input.setKey(code, d);
    setDown(d);
  };
  return (
    <button
      type="button"
      className={cx('tc-btn', className, down && 'down')}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        set(true);
      }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
    >
      {children}
    </button>
  );
}

/** A button that fires a key press the moment it's touched. */
function Tap({ input, a, className, children }: { input: Input; a: Action; className?: string; children?: ReactNode }) {
  return (
    <button
      type="button"
      className={cx('tc-btn', className)}
      onPointerDown={(e) => {
        e.preventDefault();
        input.press(a.code, a.shift);
      }}
    >
      {children ?? a.label}
    </button>
  );
}

/** Stick inside the base: past this fraction of its radius a direction counts as held. */
const DEAD = 0.3;
/** How far (rem) the knob travels from the centre at full deflection: the base's radius less the knob's (touch.css). */
const KNOB_REACH = 2.3;

/** Left thumb: strafe (left / right) and thrust (up the stick is forward, W; down is back, S). */
function Stick({ input }: { input: Input }) {
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);
  const pointer = useRef<number | null>(null);
  const drive = (e: RPointerEvent) => {
    const el = base.current!;
    const r = el.getBoundingClientRect();
    const reach = r.width / 2;
    let x = (e.clientX - (r.left + reach)) / reach,
      y = (e.clientY - (r.top + reach)) / reach;
    const len = Math.hypot(x, y);
    if (len > 1) {
      x /= len;
      y /= len;
    }
    knob.current!.style.transform = `translate(${x * KNOB_REACH}rem, ${y * KNOB_REACH}rem)`;
    input.setKey('KeyD', x > DEAD);
    input.setKey('KeyA', x < -DEAD);
    input.setKey('KeyS', y > DEAD);
    input.setKey('KeyW', y < -DEAD);
  };
  const release = () => {
    pointer.current = null;
    knob.current!.style.transform = '';
    for (const k of ['KeyA', 'KeyD', 'KeyW', 'KeyS']) input.setKey(k, false);
  };
  return (
    <div
      ref={base}
      className="tc-stick"
      onPointerDown={(e) => {
        if (pointer.current !== null) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        pointer.current = e.pointerId;
        drive(e);
      }}
      onPointerMove={(e) => pointer.current === e.pointerId && drive(e)}
      onPointerUp={(e) => pointer.current === e.pointerId && release()}
      onPointerCancel={(e) => pointer.current === e.pointerId && release()}
      onLostPointerCapture={(e) => pointer.current === e.pointerId && release()}
    >
      <span className="tc-dir n">W</span>
      <span className="tc-dir s">S</span>
      <span className="tc-dir w">A</span>
      <span className="tc-dir e">D</span>
      <div ref={knob} className="tc-knob" />
    </div>
  );
}

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen?.().catch(() => {});
}

export function TouchControls({ input, hud }: { input: Input; hud: HudSnapshot }) {
  const [sheet, setSheet] = useState(false);
  if (hud.pause) return null; // the pause menu is plain buttons
  if (hud.mapOpen) {
    // the system map: drag turns it, pinch zooms, tap picks; this closes it
    return (
      <div className="tc" onContextMenu={(e) => e.preventDefault()}>
        <Tap input={input} a={{ label: 'Close map', code: 'KeyO', shift: true }} className="tc-wide tc-close" />
      </div>
    );
  }
  if (hud.docked) return null; // the station window has its own buttons
  const ctx = panelKeys(hud);
  return (
    <div className="tc" onContextMenu={(e) => e.preventDefault()}>
      <Tap input={input} a={{ label: 'Pause', code: 'Escape' }} className="tc-pause">
        ❚❚
      </Tap>
      <div className="tc-left">
        <Stick input={input} />
        <div className="tc-vert">
          <Hold input={input} code="Space">▲</Hold>
          <Hold input={input} code="KeyC">▼</Hold>
          <Hold input={input} code="KeyQ">⟲</Hold>
          <Hold input={input} code="KeyE">⟳</Hold>
        </div>
      </div>
      {ctx.length > 0 && (
        <div className="tc-ctx">
          {ctx.map((a) => (
            <Tap key={a.label} input={input} a={a} className="tc-key" />
          ))}
        </div>
      )}
      <div className="tc-right">
        <Tap input={input} a={{ label: 'FTL', code: 'KeyJ' }} className="tc-ftl" />
        <Hold input={input} code="ShiftLeft" className="tc-boost">BOOST</Hold>
        <Tap input={input} a={{ label: 'Target', code: 'KeyT' }} />
        <Tap input={input} a={{ label: 'Next', code: 'KeyG' }} />
        <Tap input={input} a={{ label: 'Stop', code: 'KeyX' }} className="tc-stop" />
        <button type="button" className={cx('tc-btn', sheet && 'down')} onPointerDown={(e) => { e.preventDefault(); setSheet((s) => !s); }}>
          MORE
        </button>
      </div>
      {sheet && (
        <div className="tc-sheet" onPointerDown={(e) => e.target === e.currentTarget && setSheet(false)}>
          <div className="tc-sheetbox">
            {SHEET.map((g) => (
              <section key={g.title}>
                <h4>{g.title}</h4>
                <div className="tc-grid" onPointerUp={() => setSheet(false)}>
                  {g.actions.map((a) => (
                    <Tap key={a.label} input={input} a={a} className="tc-act" />
                  ))}
                </div>
              </section>
            ))}
            <section>
              <h4>DISPLAY</h4>
              <div className="tc-grid">
                <button type="button" className="tc-btn tc-act" onPointerDown={(e) => { e.preventDefault(); toggleFullscreen(); }}>Fullscreen</button>
                <Tap input={input} a={{ label: 'Performance', code: 'Backquote' }} className="tc-act" />
              </div>
            </section>
            <button type="button" className="tc-btn tc-act tc-done" onPointerDown={(e) => { e.preventDefault(); setSheet(false); }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
