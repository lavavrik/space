import { Anchor, Coins } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { RESOURCE_ICONS, type ResourceIcon } from './icons';
import type { HudSnapshot } from '../../game/hud/types';
import { ContractsBody, type ContractActions } from './ContractsPanel';
import { OutfitBody, type OutfitActions } from './OutfitPanel';
import { Panel, cx } from './primitives';

type Docked = NonNullable<HudSnapshot['docked']>;
type Tab = Docked['tab'];

interface Actions extends ContractActions, OutfitActions {
  tab: (t: Tab) => void;
  buyFuel: (f: 'prop' | 'exotic' | 'o2', toKg: number) => void;
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

/** A group on the Services tab: an icon and a title over its contents, ruled off from the next. */
function Group({ icon, title, children }: { icon: ResourceIcon; title: string; children: ReactNode }) {
  const I = RESOURCE_ICONS[icon];
  return (
    <section className="svgroup">
      <div className="svhead">
        <I weight="duotone" /> {title}
      </div>
      {children}
    </section>
  );
}

const fmtKg = (kg: number, cap: number) => (cap >= 10_000 ? `${(kg / 1000).toFixed(1)} t` : cap >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(1)} kg`);
const fmtCr = (x: number) => `${Math.round(x).toLocaleString('en-US')} Cr`;

/**
 * One fuel: the tank now, and a slider for the level to fill it to (from what's in it to full), with
 * what that costs here; "buy" fills to the slider, "fill up" to full, both as far as your credits go.
 */
function FuelGroup({ f, credits, onBuy }: { f: Docked['fuels'][number]; credits: number; onBuy: (toKg: number) => void }) {
  const [to, setTo] = useState(f.capKg);
  const level = Math.min(f.capKg, Math.max(f.haveKg, to)); // (after buying, the tank may be past the slider)
  const cost = (level - f.haveKg) * f.price,
    full = (f.capKg - f.haveKg) * f.price;
  const afford = f.haveKg + credits / f.price;
  const tiny = f.capKg * 1e-4;
  return (
    <Group icon={f.id} title={f.name}>
      <div className="svline">
        <span>
          {fmtKg(f.haveKg, f.capKg)} / {fmtKg(f.capKg, f.capKg)}
        </span>
        <b>{f.price < 1 ? f.price.toFixed(3) : f.price.toFixed(1)} Cr/kg</b>
      </div>
      <div className={cx('bar', f.id === 'exotic' && 'ftl', f.id === 'o2' && 'o2', 'svfill')}>
        <i className="svto" style={{ width: `${(level / f.capKg) * 100}%` }} />
        <i style={{ width: `${(f.haveKg / f.capKg) * 100}%` }} />
      </div>
      <input
        type="range"
        className="svslider"
        min={0}
        max={f.capKg}
        step={f.capKg / 200}
        value={level}
        disabled={f.haveKg >= f.capKg - tiny}
        onChange={(e) => setTo(Math.max(f.haveKg, +e.target.value))}
        aria-label={`Fill ${f.name} to`}
      />
      <div className="obtns">
        <button type="button" className="obtn" disabled={level - f.haveKg <= tiny} onClick={() => onBuy(level)}>
          {level - f.haveKg <= tiny ? 'drag to pick a level' : `fill to ${fmtKg(level, f.capKg)} · ${fmtCr(cost)}`}
        </button>
        <button type="button" className="obtn" disabled={f.haveKg >= f.capKg - tiny} onClick={() => onBuy(f.capKg)}>
          {f.haveKg >= f.capKg - tiny ? 'full' : `fill up · ${fmtCr(full)}`}
        </button>
      </div>
      {afford < f.capKg - tiny && <div className="ohint">Your credits buy up to {fmtKg(afford, f.capKg)}</div>}
    </Group>
  );
}

/**
 * The station window, while docked (it opens on docking, and on loading a game docked; Game.openStation):
 *   - Trading: the metal in your hold at this station's prices (each ±20 % on list, a hash of its
 *     name: worth shopping round), sold one at a time or all together;
 *   - Services, in groups: credits, each fuel (bought separately, up to a level picked on a slider),
 *     repairs, the station's shore power, and leaving (launch, or a sky station's catapult);
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
          <div className="svline">
            <span className="svcr">
              <Coins weight="duotone" /> {d.credits}
            </span>
            <span className="ohint">they buy metal · prices against list</span>
          </div>
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
        <div className="svgroups">
          <Group icon="credits" title="Credits">
            <div className="svbig">{d.credits}</div>
          </Group>
          {d.fuels.map((f) => (
            <FuelGroup key={f.id} f={f} credits={d.creditsN} onBuy={(kg) => act.buyFuel(f.id, kg)} />
          ))}
          <Group icon="repair" title="Hull">
            <div className="svline">
              <span>Integrity</span>
              <b>{d.hull.pct}</b>
            </div>
            <div className="bar">
              <i style={{ width: `${d.hull.frac * 100}%` }} />
            </div>
            <div className="obtns">
              <button type="button" className="obtn" onClick={act.repair} disabled={d.hullFull}>
                {d.hullFull ? 'hull sound' : `repair · ${d.repair}`}
              </button>
            </div>
          </Group>
          <Group icon="power" title="Station">
            {d.notes.map((n) => (
              <div key={n} className="ohint">
                {n}
              </div>
            ))}
          </Group>
          <Group icon="launch" title="Leave">
            <div className="obtns">
              <button type="button" className="obtn" onClick={act.launch}>
                {d.deck ? 'lift off (K)' : 'launch (K)'}
              </button>
              {d.sky && (
                <button type="button" className="obtn" onClick={act.catapult}>
                  catapult (⇧K)
                </button>
              )}
            </div>
          </Group>
        </div>
      )}
      {d.tab === 'contracts' && d.jobs && <ContractsBody v={d.jobs} act={act} />}
      {d.tab === 'outfit' && d.outfit && <OutfitBody v={d.outfit} act={act} />}
    </Panel>
  );
}
