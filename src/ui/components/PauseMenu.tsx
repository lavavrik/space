import { Coins, FloppyDisk, Keyboard, Play, SpeakerHigh, SpeakerSlash, Tag } from '@phosphor-icons/react';
import type { HudSnapshot } from '../../game/hud/types';
import { cx } from './primitives';

interface Actions {
  resume: () => void;
  controls: () => void;
  sound: () => void;
  names: () => void;
  save: () => void;
  newGame: () => void;
}

/**
 * The pause menu (Esc with the cursor free; Game.pause): the game stands still behind it. Resume
 * (or Esc) takes the mouse back; the rest are the settings worth reaching from here, the save, and
 * starting over (two clicks).
 */
export function PauseMenu({ p, save, act }: { p: NonNullable<HudSnapshot['pause']>; save: HudSnapshot['save']; act: Actions }) {
  return (
    <div id="pause" role="dialog" aria-label="Paused">
      <div className="pmbox pan">
        <div className="pmtitle">PAUSED</div>
        <div className="pmsub">
          {p.system} ·{' '}
          <span className="svcr">
            <Coins weight="duotone" /> {p.credits}
          </span>
        </div>
        <button type="button" className="pmbtn main" onClick={act.resume}>
          <Play weight="fill" /> Resume <kbd>Esc</kbd>
        </button>
        <button type="button" className="pmbtn" onClick={act.controls}>
          <Keyboard weight="duotone" /> Controls <kbd>Tab</kbd>
        </button>
        <button type="button" className="pmbtn" onClick={act.sound}>
          {p.sound ? <SpeakerHigh weight="duotone" /> : <SpeakerSlash weight="duotone" />} Sound {p.sound ? 'on' : 'off'} <kbd>⇧P</kbd>
        </button>
        <button type="button" className="pmbtn" onClick={act.names}>
          <Tag weight="duotone" /> Object names {p.names ? 'shown' : 'hidden'} <kbd>⇧N</kbd>
        </button>
        <button type="button" className="pmbtn" onClick={act.save}>
          <FloppyDisk weight="duotone" /> Save now
        </button>
        <div className="pmsave">{save.status}</div>
        <button type="button" className={cx('pmbtn', 'danger', save.confirm && 'armed')} onClick={act.newGame}>
          {save.confirm ? 'Click again: the save is deleted and you start over' : 'New game'}
        </button>
      </div>
    </div>
  );
}
