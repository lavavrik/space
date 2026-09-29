import type { OutfitView } from '../../game/hud/types';
import { CaretLeft } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { ModuleArt } from './ModuleArt';
import type { ModuleIcon } from '../../game/hud/types';
import { Panel, cx } from './primitives';

export interface OutfitActions {
  battery: (id: string) => void;
  fit: (slot: number, id: string) => void;
  remove: (slot: number) => void;
  radiators: () => void;
  pump: () => void;
}

/**
 * Outfit (Shift+U): the ship's utility slots and its thermal hardware. Alongside a station (in its
 * frame, nearly at rest) each slot can be refitted from the catalogue; elsewhere it's read-only apart
 * from deploying the radiators and switching the heat pump.
 */
export function OutfitPanel({ v, act }: { v: OutfitView; act: OutfitActions & { back: () => void } }) {
  return (
    <Panel name="outfit" id="outfit" className="pan" title="OUTFIT" right="⇧U HIDES">
      <button type="button" className="oback" onClick={act.back}>
        <CaretLeft weight="bold" /> SHIP STATS
      </button>
      <OutfitBody v={v} act={act} />
    </Panel>
  );
}

/** A module or battery as a full card: its drawing, name and maker, what it does, its specs; and an action. */
function Card({ c, action }: { c: { unit: string; maker: string; blurb: string; specs: string; icon: ModuleIcon; price?: string }; action?: ReactNode }) {
  return (
    <div className="ocard">
      <ModuleArt icon={c.icon} size={40} />
      <div className="octext">
        <div className="octop">
          <b>{c.unit}</b>
          {c.price && <span className="ocprice">{c.price}</span>}
        </div>
        <div className="ocmaker">{c.maker}</div>
        <div className="ocblurb">{c.blurb}</div>
        <div className="ocspecs">{c.specs}</div>
        {action && <div className="obtns">{action}</div>}
      </div>
    </div>
  );
}

type Pick = 'battery' | number | null;

/**
 * The window's contents (also the station window's Outfitting tab): the battery and the utility
 * slots as tiles; click one to see what's fitted, and alongside a station, what could go there
 * instead, as cards (grouped by kind, each with its price). Nothing's listed until a tile is picked.
 */
export function OutfitBody({ v, act }: { v: OutfitView; act: OutfitActions }) {
  const [pick, setPick] = useState<Pick>(null);
  const toggle = (p: Pick) => setPick((q) => (q === p ? null : p));
  const kinds = [...new Set(v.catalogue.map((m) => m.kind))];
  const slot = typeof pick === 'number' ? v.slots[pick] : null;
  return (
    <>
      <div className="ohint">{v.station ? `Alongside ${v.station} · pick a slot to refit it` : v.hint}</div>
      <div className="otiles">
        <button type="button" className={cx('otile', pick === 'battery' && 'cur')} onClick={() => toggle('battery')}>
          <ModuleArt icon="battery" />
          <span className="otslot">BATTERY</span>
          <b>{v.battery.unit}</b>
        </button>
        {v.slots.map((s, i) => (
          <button key={i} type="button" className={cx('otile', s.empty && 'empty', pick === i && 'cur')} onClick={() => toggle(i)}>
            <ModuleArt icon={s.icon} />
            <span className="otslot">SLOT {i + 1}</span>
            <b>{s.empty ? 'empty' : s.unit}</b>
          </button>
        ))}
      </div>
      {pick === 'battery' && (
        <div className="opick">
          <Card c={{ ...v.battery, icon: 'battery' }} />
          {v.battery.options.length > 0 && <div className="isec">BATTERIES AT {v.station!.toUpperCase()}</div>}
          {v.battery.options.map((b) => (
            <Card
              key={b.id}
              c={b}
              action={
                <button type="button" className={cx('obtn', b.current && 'cur')} disabled={b.current} onClick={() => act.battery(b.id)}>
                  {b.current ? 'fitted' : 'fit'}
                </button>
              }
            />
          ))}
        </div>
      )}
      {slot && typeof pick === 'number' && (
        <div className="opick">
          {slot.empty ? (
            <div className="ohint">Slot {pick + 1} is empty</div>
          ) : (
            <Card
              c={slot}
              action={
                v.station && (
                  <button type="button" className="obtn rm" onClick={() => act.remove(pick)}>
                    remove (bought back at half price)
                  </button>
                )
              }
            />
          )}
          {kinds.map((k) => (
            <div key={k} className="okind">
              <div className="isec">{k}</div>
              {v.catalogue
                .filter((m) => m.kind === k)
                .map((m) => (
                  <Card
                    key={m.id}
                    c={m}
                    action={
                      <button type="button" className={cx('obtn', m.id === slot.id && 'cur')} disabled={m.id === slot.id} onClick={() => act.fit(pick, m.id)}>
                        {m.id === slot.id ? 'fitted here' : slot.empty ? 'fit' : 'replace with this'}
                      </button>
                    }
                  />
                ))}
            </div>
          ))}
        </div>
      )}
      <div className="isec">THERMAL</div>
      <div className="row">
        <span>RADIATORS</span>
        <b>{v.radiators.status}</b>
      </div>
      {v.radiators.fitted && (
        <button type="button" className="obtn" onClick={act.radiators}>
          {v.radiators.deploying ? 'stow (⇧R)' : 'deploy (⇧R)'}
        </button>
      )}
      <div className="row">
        <span>HEAT PUMP</span>
        <b>{v.pump.status}</b>
      </div>
      {v.pump.fitted && (
        <button type="button" className="obtn" onClick={act.pump}>
          {v.pump.auto ? 'switch off' : 'switch on (auto)'}
        </button>
      )}
      <div className="row">
        <span>HYDROGEN VENT</span>
        <b>built in · R</b>
      </div>
      <div className="row">
        <span>MODULE MASS</span>
        <b>{v.mass}</b>
      </div>
    </>
  );
}
