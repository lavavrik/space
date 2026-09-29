/** Keys whose browser default (scrolling, focus moves, …) we suppress. */
const HANDLED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
  'KeyJ', 'KeyH', 'KeyN', 'KeyT', 'KeyG', 'KeyX', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyZ', 'KeyV', 'KeyF', 'KeyI', 'KeyU', 'KeyB', 'KeyY', 'KeyM', 'Slash', 'KeyL', 'Backquote', 'Backspace', 'KeyO', 'KeyR', 'KeyP', 'KeyK', 'BracketLeft', 'BracketRight', 'Enter', 'NumpadEnter', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Comma', 'Period', 'Escape',
]);

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
  /** Cursor over the canvas (CSS px), for hover highlights; `over` is false when it's elsewhere. */
  readonly mouse = { x: 0, y: 0, over: false };
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    handlers: InputHandlers,
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
    this.listen(document, 'pointerlockchange', () => handlers.onPointerLockChange(this.isLocked()));
  }

  isLocked() {
    return document.pointerLockElement === this.canvas;
  }

  requestLock() {
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      if (p && p.catch) p.catch(() => {});
    } catch {
      // pointer lock is unavailable (e.g. in an iframe); dragging still steers
    }
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
