import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Game } from '../../game/Game';
import { initGpu } from '../../game/gpu/device';
import type { HudStore } from '../../game/hud/HudStore';

declare global {
  interface Window {
    /** Console access for debugging: `farlight.step(seconds)` fast-forwards the simulation. */
    farlight?: Game;
    /** Dev builds: camera poses for checking how things look (game/debug/poses.ts). */
    farlightPose?: Record<string, () => string>;
  }
}

/** Mount a Game into the returned host element for the component's lifetime. */
export function useGame() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [game, setGame] = useState<Game | null>(null);
  useEffect(() => {
    // the renderer is WebGPU (docs/webgpu.md); getting a device is asynchronous, so the game is made
    // once it's there. Without WebGPU the game can't run: say so where the view would be.
    let g: Game | null = null;
    let gone = false;
    void (async () => {
      const gpu = await initGpu();
      if (gone) return;
      if (typeof gpu === 'string') {
        const m = document.createElement('div');
        m.id = 'nogpu';
        m.textContent = `${gpu} Farlight needs WebGPU: a current Chrome, Edge, Safari (26+) or Firefox (141+).`;
        hostRef.current!.append(m);
        return;
      }
      g = new Game(hostRef.current!, gpu);
      window.farlight = g;
      if (import.meta.env.DEV) {
        // the pause menu's debug jumps, in the console too: farlightPose.belt(), .station(), …
        const game = g;
        void import('../../game/debug/poses').then(({ debugSpots }) => {
          window.farlightPose = new Proxy({} as Record<string, () => string>, {
            get: (_, id) => () => {
              const s = debugSpots(game).find((x) => x.id === id);
              if (!s) return `no ${String(id)} here: ${debugSpots(game).map((x) => x.id).join(', ')}`;
              s.go();
              game.paused = true;
              return s.hint;
            },
          });
        });
      }
      setGame(g);
    })();
    return () => {
      gone = true;
      g?.dispose();
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
