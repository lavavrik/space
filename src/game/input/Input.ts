/** Keys whose browser default (scrolling, focus moves, …) we suppress. */
const HANDLED = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ControlLeft', 'ControlRight', 'KeyC', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight',
  'KeyJ', 'KeyH', 'KeyN', 'KeyT', 'KeyG', 'KeyX', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyZ', 'KeyO', 'KeyR', 'KeyP', 'KeyK', 'BracketLeft', 'BracketRight', 'Enter', 'NumpadEnter', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
]);

export type Keys = Record<string, boolean | undefined>;

export interface InputHandlers {
  /** A key went down (not a repeat). */
  onPress(code: string): void;
  /** A held key auto-repeated. */
  onRepeat(code: string): void;
  onWheel(deltaY: number): void;
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
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    handlers: InputHandlers,
  ) {
    this.listen(window, 'keydown', (e: KeyboardEvent) => {
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
    this.listen(canvas, 'mousedown', () => {
      if (!handlers.isActive()) return;
      if (!this.isLocked()) {
        this.dragging = true;
        this.requestLock();
      }
    });
    this.listen(window, 'mouseup', () => {
      this.dragging = false;
    });
    this.listen(window, 'mousemove', (e: MouseEvent) => {
      if (this.isLocked() || this.dragging) {
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
