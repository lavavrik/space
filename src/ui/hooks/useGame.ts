import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Game } from '../../game/Game';
import type { HudStore } from '../../game/hud/HudStore';

declare global {
  interface Window {
    /** Console access for debugging: `farlight.step(seconds)` fast-forwards the simulation. */
    farlight?: Game;
  }
}

/** Mount a Game into the returned host element for the component's lifetime. */
export function useGame() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  useEffect(() => {
    const g = new Game(hostRef.current!);
    window.farlight = g;
    setGame(g);
    return () => {
      g.dispose();
      if (window.farlight === g) delete window.farlight;
    };
  }, []);
  return { hostRef, game };
}

const noStore: Pick<HudStore, 'subscribe' | 'getSnapshot'> = { subscribe: () => () => {}, getSnapshot: () => null };

/** The latest HUD snapshot published by the game. */
export function useHud(game: Game | null) {
  const store = game ? game.hud : noStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
