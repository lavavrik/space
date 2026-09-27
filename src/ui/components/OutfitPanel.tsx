import type { OutfitView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

interface Actions {
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
export function OutfitPanel({ v, act }: { v: OutfitView; act: Actions }) {
  return (
    <Panel name="outfit" id="outfit" className="pan" title="OUTFIT" right="⇧U HIDES">
      <div className="ohint">{v.station ? `Alongside ${v.station} · pick a module for a slot` : v.hint}</div>
      <div className="oslot">
        <div className="gtop">
          <span>BATTERY</span>
          <b>{v.battery.unit}</b>
        </div>
        <div className="avspecs">{v.battery.specs}</div>
        {v.battery.options.length > 0 && (
          <div className="obtns">
            {v.battery.options.map((b) => (
              <button key={b.id} type="button" className={cx('obtn', b.current && 'cur')} title={b.specs} disabled={b.current} onClick={() => act.battery(b.id)}>
                {b.unit}
              </button>
            ))}
          </div>
        )}
      </div>
      {v.slots.map((s, i) => (
        <div key={i} className={cx('oslot', s.empty && 'empty')}>
          <div className="gtop">
            <span>SLOT {i + 1}</span>
            <b>{s.unit}</b>
          </div>
          {!s.empty && <div className="avdoes">{s.blurb}</div>}
          {!s.empty && <div className="avspecs">{s.specs}</div>}
          {v.station && (
            <div className="obtns">
              {v.catalogue.map((m) => (
                <button key={m.id} type="button" className="obtn" title={`${m.blurb} · ${m.specs}`} onClick={() => act.fit(i, m.id)}>
                  {m.unit}
                </button>
              ))}
              {!s.empty && (
                <button type="button" className="obtn rm" onClick={() => act.remove(i)}>
                  remove
                </button>
              )}
            </div>
          )}
        </div>
      ))}
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
    </Panel>
  );
}
