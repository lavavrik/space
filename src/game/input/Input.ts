/** Keys whose browser default (scrolling, focus moves, …) we suppress. */
const HANDLED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
  'KeyJ', 'KeyH', 'KeyN', 'KeyT', 'KeyG', 'KeyX', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyZ', 'KeyV', 'KeyF', 'KeyI', 'KeyU', 'KeyB', 'KeyY', 'KeyM', 'Slash', 'KeyL', 'Backquote', 'Backspace', 'KeyO', 'KeyR', 'KeyP', 'KeyK', 'BracketLeft', 'BracketRight', 'Enter', 'NumpadEnter', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Comma', 'Period', 'Escape',
]);

/** A finger on the canvas. */
interface Finger {
  x: number;
  y: number;
  x0: number;
  y0: number;
  t0: number;
  /** Still a tap: hasn't moved past TAP_SLOP and is the only finger. */
  tap: boolean;
}

/** A touch that moves less than this many px and lifts within TAP_MS is a tap, not a drag. */
const TAP_SLOP = 10;
const TAP_MS = 350;
/** Look speed of a dragging finger relative to a mouse (a finger covers less distance than a wrist). */
const TOUCH_LOOK = 1.6;
/** Pinch distance (px) per zoom step. */
const PINCH_STEP = 28;

export type Keys = Record<string, boolean | undefined>;

export interface InputHandlers {
  /** A key went down (not a repeat). */
  onPress(code: string): void;
  /** A held key auto-repeated. */
  onRepeat(code: string): void;
  onWheel(deltaY: number): void;
  /** A click that didn't drag, at canvas pixel (x, y). While the pointer is locked it's always the centre. */
  onClick(x: number, y: number, locked: boolean): void;
  /** Middle mouse button (wheel click): pivot to the target. */
  onMiddleClick(): void;
  /** Whether the mouse steers the ship yet. */
  isActive(): boolean;
  onPointerLockChange(locked: boolean): void;
}

/** Keyboard and mouse state. Held keys are polled each frame; presses are dispatched as events. */
export class Input {
  readonly keys: Keys = Object.create(null);
  private mdx = 0;
  private mdy = 0;
  private dragging = false;
  private dragDist = 0; // px moved since mousedown, to tell a click from a drag
  /** Fingers on the canvas one looks or taps, two pinch. */
  private readonly fingers = new Map<number, Finger>();
  private pinch = 0; // distance between two fingers last move
  private pinchAcc = 0; // px of pinch not yet turned into a zoom step
  /** Cursor over the canvas (CSS px), for hover highlights; `over` is false when it's elsewhere. */
  /** A touch screen is in use (a finger has touched the page, the primary pointer is coarse, or `?touch` forces the layout): no pointer lock to ask for. */
  touch = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('touch'));
  readonly mouse = { x: 0, y: 0, over: false };
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly handlers: InputHandlers,
  ) {
    this.listen(window, 'keydown', (e: KeyboardEvent) => {
      // typing into a text field (the nav search) goes to the field, not the ship
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (HANDLED.has(e.code)) e.preventDefault();
      if (!e.repeat) handlers.onPress(e.code);
      else handlers.onRepeat(e.code);
      this.keys[e.code] = true;
    });
    this.listen(window, 'keyup', (e: KeyboardEvent) => {
      this.keys[e.code] = false;
    });
    this.listen(window, 'wheel', (e: WheelEvent) => handlers.onWheel(e.deltaY), { passive: true });
    this.listen(window, 'blur', () => {
      for (const k in this.keys) this.keys[k] = false;
      this.dragging = false;
    });
    // Unlocked: dragging steers, and a click either targets what's under the cursor or (via the
    // handler) captures the mouse. Locked: a click targets what's under the crosshair.
    this.listen(canvas, 'mousedown', (e: MouseEvent) => {
      if (e.button === 1) {
        e.preventDefault(); // no autoscroll
        handlers.onMiddleClick();
        return;
      }
      if (!handlers.isActive() || e.button !== 0) return;
      this.dragging = true;
      this.dragDist = 0;
    });
    this.listen(window, 'mouseup', (e: MouseEvent) => {
      if (this.dragging && this.dragDist < 5 && e.button === 0) {
        const r = canvas.getBoundingClientRect();
        handlers.onClick(e.clientX - r.left, e.clientY - r.top, this.isLocked());
      }
      this.dragging = false;
    });
    this.listen(canvas, 'mouseleave', () => (this.mouse.over = false));
    this.listen(window, 'mousemove', (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
      this.mouse.over = e.target === canvas;
      if (this.dragging) this.dragDist += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (this.isLocked() || (this.dragging && this.dragDist >= 5)) {
        this.mdx += e.movementX;
        this.mdy += e.movementY;
      }
    });
    this.listenTouch(canvas);
    // (a finger anywhere, the on-screen buttons included: the pause button is often the first thing touched)
    this.listen(window, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType === 'touch') this.touch = true;
    }, { capture: true, passive: true });
    this.listen(document, 'pointerlockchange', () => handlers.onPointerLockChange(this.isLocked()));
  }

  isLocked() {
    return document.pointerLockElement === this.canvas;
  }

  requestLock() {
    // not on a touch screen: there's no mouse to capture, and a lock there (a browser that grants
    // one, like a desktop's device emulation or a tablet's) broke steering for good: while a pointer
    // is locked setPointerCapture throws, so the finger never registered (resuming from the pause
    // menu, or a debug jump, left every drag dead)
    if (this.touch) return;
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && p.catch) p.catch(() => {});
    } catch {
      // pointer lock is unavailable (e.g. in an iframe); dragging still steers
    }
  }

  /** Hold or release a key from a touch control: polled each frame like a real one. */
  setKey(code: string, down: boolean) {
    this.keys[code] = down;
  }

  /** A key press from a touch button; Shift is held for the length of it when `shift`, and not when it isn't (even if boost is held). */
  press(code: string, shift = false) {
    const [l, r] = [this.keys.ShiftLeft, this.keys.ShiftRight];
    this.keys.ShiftLeft = shift;
    this.keys.ShiftRight = false;
    this.handlers.onPress(code);
    this.keys.ShiftLeft = l;
    this.keys.ShiftRight = r;
  }

  /**
   * Fingers on the canvas (the HUD lets touches through): one finger dragging steers like the
   * mouse, a short still touch taps (targets what's under it), two fingers pinch (zoom). Touches
   * that start on a control are theirs and never reach the canvas.
   */
  private listenTouch(canvas: HTMLCanvasElement) {
    this.listen(canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      e.preventDefault(); // no emulated mouse events after it
      this.touch = true;
      // a finger: let go of any pointer lock (it can't be steered with), and register the finger
      // before asking for capture, which still throws if the lock hasn't gone yet (the finger then
      // works without it while it stays over the canvas)
      if (this.isLocked()) document.exitPointerLock?.();
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: e.timeStamp, tap: this.fingers.size === 0 });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* see above */
      }
      if (this.fingers.size === 2) {
        this.pinch = this.span();
        this.pinchAcc = 0;
      }
    });
    this.listen(canvas, 'pointermove', (e: PointerEvent) => {
      const f = this.fingers.get(e.pointerId);
      if (!f) return;
      if (this.fingers.size >= 2) {
        const d = this.span();
        // one zoom step (a wheel notch) per PINCH_STEP px the fingers spread or close
        this.pinchAcc += this.pinch - d;
        this.pinch = d;
        while (Math.abs(this.pinchAcc) >= PINCH_STEP) {
          this.handlers.onWheel(Math.sign(this.pinchAcc));
          this.pinchAcc -= Math.sign(this.pinchAcc) * PINCH_STEP;
        }
        f.x = e.clientX;
        f.y = e.clientY;
        f.tap = false;
        return;
      }
      if (Math.hypot(e.clientX - f.x0, e.clientY - f.y0) >= TAP_SLOP) f.tap = false;
      if (!f.tap) {
        this.mdx += (e.clientX - f.x) * TOUCH_LOOK;
        this.mdy += (e.clientY - f.y) * TOUCH_LOOK;
      }
      f.x = e.clientX;
      f.y = e.clientY;
    });
    const up = (e: PointerEvent) => {
      const f = this.fingers.get(e.pointerId);
      if (!f) return;
      this.fingers.delete(e.pointerId);
      if (e.type === 'pointerup' && f.tap && e.timeStamp - f.t0 < TAP_MS && this.handlers.isActive()) {
        const r = canvas.getBoundingClientRect();
        this.handlers.onClick(f.x - r.left, f.y - r.top, false);
      }
    };
    this.listen(canvas, 'pointerup', up);
    this.listen(canvas, 'pointercancel', up);
  }

  private span() {
    const [a, b] = [...this.fingers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Mouse movement since the last call, in pixels. */
  consumeMouse(): [number, number] {
    const d: [number, number] = [this.mdx, this.mdy];
    this.mdx = this.mdy = 0;
    return d;
  }

  dispose() {
    for (const off of this.cleanup) off();
    this.cleanup.length = 0;
  }

  private listen<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, opts?: AddEventListenerOptions) {
    const h = fn as EventListener;
    target.addEventListener(type, h, opts);
    this.cleanup.push(() => target.removeEventListener(type, h, opts));
  }
}
