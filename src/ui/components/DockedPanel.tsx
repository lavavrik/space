import { Anchor } from '@phosphor-icons/react';
import type { HudSnapshot } from '../../game/hud/types';
import { Panel } from './primitives';

interface Actions {
  refuel: () => void;
  repair: () => void;
  sell: () => void;
  outfit: () => void;
  launch: () => void;
  catapult: () => void;
}

/**
 * Docked at a station (sim/docking.ts): where, your credits, and the station's services at its prices
 * (sim/economy.ts): fuel, repairs, buying your hold's metal, outfitting. Shore power charges the
 * battery and the station cools the hull on its own, free.
 */
export function DockedPanel({ d, act }: { d: NonNullable<HudSnapshot['docked']>; act: Actions }) {
  return (
    <Panel name="docked" id="docked" className="pan" title="DOCKED" right={`PAD ${d.pad}`}>
      <div className="dkname">
        <Anchor weight="duotone" /> {d.station}
      </div>
      <div className="ohint">You have {d.credits}</div>
      {d.notes.map((n) => (
        <div key={n} className="ohint">
          {n}
        </div>
      ))}
      <div className="obtns">
        <button type="button" className="obtn" onClick={act.refuel} disabled={d.tanksFull}>
          {d.tanksFull ? 'tanks full' : `refuel H₂ + exotic · ${d.refuel}`}
        </button>
        <button type="button" className="obtn" onClick={act.repair} disabled={d.hullFull}>
          {d.hullFull ? 'hull sound' : `repair hull · ${d.repair}`}
        </button>
        {d.cargo && (
          <button type="button" className="obtn" onClick={act.sell}>
            sell the hold · {d.cargo}
          </button>
        )}
        <button type="button" className="obtn" onClick={act.outfit}>
          outfitting (⇧U)
        </button>
        <button type="button" className="obtn" onClick={act.launch}>
          {d.sky ? 'lift off (K)' : 'launch (K)'}
        </button>
        {d.sky && (
          <button type="button" className="obtn" onClick={act.catapult}>
            catapult (⇧K)
          </button>
        )}
      </div>
    </Panel>
  );
}
