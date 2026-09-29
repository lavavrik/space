import { Anchor } from '@phosphor-icons/react';
import type { HudSnapshot } from '../../game/hud/types';
import { ContractsBody, type ContractActions } from './ContractsPanel';
import { OutfitBody, type OutfitActions } from './OutfitPanel';
import { Panel, cx } from './primitives';

type Docked = NonNullable<HudSnapshot['docked']>;
type Tab = Docked['tab'];

interface Actions extends ContractActions, OutfitActions {
  tab: (t: Tab) => void;
  refuel: () => void;
  repair: () => void;
  sell: (c: Docked['trade'][number]['id']) => void;
  sellAll: () => void;
  cargo: () => void;
  launch: () => void;
  catapult: () => void;
}

const TABS: [Tab, string][] = [
  ['trade', 'Trading'],
  ['services', 'Services'],
  ['contracts', 'Contracts'],
  ['outfit', 'Outfitting'],
];

/**
 * The station window, while docked (it opens on docking, and on loading a game docked; Game.openStation):
 *   - Trading: the metal in your hold at this station's prices (each ±20 % on list, a hash of its
 *     name: worth shopping round), sold one at a time or all together;
 *   - Services: fuel, repairs, and leaving (launch, or a sky station's catapult);
 *   - Contracts: its job board and your jobs (as the contracts window, Shift+J);
 *   - Outfitting: the utility slots and battery, refitted from its catalogue (as the outfit window, Shift+U).
 */
export function StationPanel({ d, act }: { d: Docked; act: Actions }) {
  return (
    <Panel name="docked" id="docked" className="pan" title="STATION" right={`PAD ${d.pad}`}>
      <div className="dkname">
        <Anchor weight="duotone" /> {d.station}
      </div>
      <div className="sttabs">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" className={cx('sttab', d.tab === t && 'cur')} onClick={() => act.tab(t)}>
            {label}
          </button>
        ))}
      </div>
      {d.tab === 'trade' && (
        <>
          <div className="ohint">You have {d.credits} · they buy metal; prices here against the list price</div>
          <div className="trlist">
            {d.trade.map((r) => (
              <div key={r.id} className={cx('trrow', r.empty && 'empty')}>
                <i className={`cgsw cg-${r.id}`} />
                <span className="trname">{r.name}</span>
                <b>{r.have}</b>
                <span className="trprice">
                  {r.price} <span className={r.vs.up ? 'trup' : 'trdown'}>{r.vs.text}</span>
                </span>
                <b>{r.empty ? '' : r.value}</b>
                {!r.empty && (
                  <button type="button" className="obtn" onClick={() => act.sell(r.id)}>
                    sell
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="obtns">
            <button type="button" className="obtn" onClick={act.sellAll} disabled={!d.cargo}>
              {d.cargo ? `sell all · ${d.cargo}` : 'no metal to sell'}
            </button>
            <button type="button" className="obtn" onClick={act.cargo}>
              cargo & tanks (⇧I)
            </button>
          </div>
        </>
      )}
      {d.tab === 'services' && (
        <>
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
            <button type="button" className="obtn" onClick={act.launch}>
              {d.sky ? 'lift off (K)' : 'launch (K)'}
            </button>
            {d.sky && (
              <button type="button" className="obtn" onClick={act.catapult}>
                catapult (⇧K)
              </button>
            )}
          </div>
        </>
      )}
      {d.tab === 'contracts' && d.jobs && <ContractsBody v={d.jobs} act={act} />}
      {d.tab === 'outfit' && d.outfit && <OutfitBody v={d.outfit} act={act} />}
    </Panel>
  );
}
