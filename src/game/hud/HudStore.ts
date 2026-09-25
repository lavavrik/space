import type { HudSnapshot } from './types';

type Listener = () => void;

/** External store for the React HUD: the game publishes a fresh snapshot a dozen times a second. */
export class HudStore {
  private snapshot: HudSnapshot | null = null;
  private readonly listeners = new Set<Listener>();

  subscribe = (fn: Listener) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  getSnapshot = () => this.snapshot;

  publish(s: HudSnapshot) {
    this.snapshot = s;
    for (const fn of this.listeners) fn();
  }
}
