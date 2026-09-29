import { Coins } from '@phosphor-icons/react';
import type { ContractsView, JobView } from '../../game/hud/types';
import { Panel, cx } from './primitives';

export interface ContractActions {
  accept: (id: string) => void;
  deliver: (id: string) => void;
  abandon: (id: string) => void;
  plot: (id: string) => void;
}

const KIND = { haul: 'HAUL', courier: 'COURIER', metal: 'METAL' } as const;

/** One job: what, where, for whom, the pay and the clock, and what you can do with it. */
function Job({ j, children }: { j: JobView; children?: React.ReactNode }) {
  return (
    <div className={cx('job', j.kind)}>
      <div className="jtop">
        <span className="jkind">{KIND[j.kind]}</span>
        <b>{j.reward}</b>
      </div>
      <div className="jtitle">{j.title}</div>
      <div className="jsub">
        {j.route} · {j.client}
      </div>
      <div className="jsub">
        <span className={cx(j.time.warn && 'warnc')}>{j.time.text}</span>
        {j.note && <span> · {j.note}</span>}
      </div>
      {j.progress !== null && (
        <div className={cx('bar', 'jbar', j.progress >= 1 && 'done')}>
          <i style={{ width: `${j.progress * 100}%` }} />
        </div>
      )}
      {children && <div className="obtns">{children}</div>}
    </div>
  );
}

/**
 * Contracts (Shift+J; sim/contracts.ts): your jobs (deliver metal, plot the way there, abandon them
 * with a second click), and docked, the station's board to take jobs from.
 */
export function ContractsPanel({ v, act }: { v: ContractsView; act: ContractActions }) {
  return (
    <Panel name="contracts" id="contracts" className="pan" title="CONTRACTS" right="⇧J HIDES">
      <ContractsBody v={v} act={act} />
    </Panel>
  );
}

/** The window's contents: also the station window's Contracts tab (StationPanel). */
export function ContractsBody({ v, act }: { v: ContractsView; act: ContractActions }) {
  return (
    <>
      <div className="sub">
        <span>
          YOUR JOBS {v.mine.length} / {v.max}
        </span>
        <span className="svcr">
          <Coins weight="duotone" /> {v.credits}
        </span>
      </div>
      {v.mine.length === 0 && <div className="ohint">None · take one from a station's board (dock, then ⇧J)</div>}
      {v.mine.map((j) => (
        <Job key={j.id} j={j}>
          {j.canDeliver && (
            <button type="button" className="obtn" onClick={() => act.deliver(j.id)}>
              deliver
            </button>
          )}
          {j.canPlot && (
            <button type="button" className="obtn" onClick={() => act.plot(j.id)}>
              plot route
            </button>
          )}
          <button type="button" className={cx('obtn', j.armed && 'warn')} onClick={() => act.abandon(j.id)}>
            {j.armed ? 'abandon it?' : 'abandon'}
          </button>
        </Job>
      ))}
      <div className="sep" />
      {v.station ? (
        <>
          <div className="sub">
            <span>BOARD · {v.station.toUpperCase()}</span>
            <span>new jobs in {v.refresh}</span>
          </div>
          {v.board.length === 0 && <div className="ohint">Nothing on offer until the next board (every 30 min)</div>}
          {v.board.map((j) => (
            <Job key={j.id} j={j}>
              <button type="button" className="obtn" disabled={!!j.note} onClick={() => act.accept(j.id)}>
                accept
              </button>
            </Job>
          ))}
        </>
      ) : (
        <div className="ohint">Dock at a station to see its job board</div>
      )}
    </>
  );
}
