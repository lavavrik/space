import { ArrowLeft, Coins, FloppyDisk, GearSix, Keyboard, MapPin, Play, SpeakerHigh, SpeakerSlash, Tag, Wrench } from '@phosphor-icons/react';
import { useState } from 'react';
import type { Settings } from '../../game/settings';
import type { HudSnapshot } from '../../game/hud/types';
import { cx } from './primitives';

interface Actions {
  resume: () => void;
  controls: () => void;
  sound: () => void;
  names: () => void;
  save: () => void;
  newGame: () => void;
  jump: (id: string) => void;
  refill: () => void;
  setting: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}

/**
 * The pause menu (Esc with the cursor free; Game.pause): the game stands still behind it. Resume
 * (or Esc) takes the mouse back; the rest are the settings worth reaching from here, the save, and
 * starting over (two clicks), and Settings (sound levels, graphics options: game/settings.ts), which
 * takes the menu's place until Back. Debug builds add a "Jump to" list beside it (debug/poses.ts): places
 * worth looking at in this system, one click each.
 */
export function PauseMenu({ p, save, act }: { p: NonNullable<HudSnapshot['pause']>; save: HudSnapshot['save']; act: Actions }) {
  const [settings, setSettings] = useState(false);
  return (
    <div id="pause" role="dialog" aria-label="Paused">
      <div className="pmrow">
      {settings ? (
        <SettingsBox s={p.settings} set={act.setting} back={() => setSettings(false)} />
      ) : (
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
        <button type="button" className="pmbtn" onClick={() => setSettings(true)}>
          <GearSix weight="duotone" /> Settings
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
      )}
      {p.spots && (
        <div className="pmbox pmdev pan">
          <div className="pmtitle">JUMP TO</div>
          <div className="pmsub">debug · this system</div>
          <button type="button" className="pmbtn pmspot" onClick={act.refill}>
            <Wrench weight="duotone" />
            <span>
              Repair &amp; refill
              <small>hull, tanks, battery, heat</small>
            </span>
          </button>
          {p.spots.map((s) => (
            <button key={s.id} type="button" className="pmbtn pmspot" onClick={() => act.jump(s.id)}>
              <MapPin weight="duotone" />
              <span>
                {s.label}
                <small>{s.hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

/** A row of choices, the current one lit. */
function Choice<T extends string | number | boolean>({ label, value, options, pick }: { label: string; value: T; options: [T, string][]; pick: (v: T) => void }) {
  return (
    <div className="setrow">
      <span className="setlabel">{label}</span>
      <span className="setopts">
        {options.map(([v, text]) => (
          <button key={String(v)} type="button" className={cx('setopt', v === value && 'on')} onClick={() => pick(v)}>
            {text}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A level, 0–100 %. */
function Level({ label, value, pick }: { label: string; value: number; pick: (v: number) => void }) {
  return (
    <div className="setrow">
      <span className="setlabel">{label}</span>
      <input className="setslider" type="range" min={0} max={100} step={5} value={Math.round(value * 100)} onChange={(e) => pick(Number(e.currentTarget.value) / 100)} />
      <span className="setval">{Math.round(value * 100)} %</span>
    </div>
  );
}

const ONOFF: [boolean, string][] = [
  [true, 'On'],
  [false, 'Off'],
];

/** The Settings panel (game/settings.ts): each change applies at once and is remembered. */
function SettingsBox({ s, set, back }: { s: Settings; set: Actions['setting']; back: () => void }) {
  return (
    <div className="pmbox setbox pan">
      <div className="pmtitle">SETTINGS</div>
      <div className="setsec">Sound</div>
      <Level label="Volume" value={s.volume} pick={(v) => set('volume', v)} />
      <Level label="Cabin hum" value={s.hum} pick={(v) => set('hum', v)} />
      <div className="setsec">Graphics</div>
      <Choice label="Frame rate" value={s.fps} options={[['display', 'Display'], ['60', '60 fps']]} pick={(v) => set('fps', v)} />
      <Choice label="Dynamic resolution" value={s.dynres} options={ONOFF} pick={(v) => set('dynres', v)} />
      <Choice label="Resolution" value={s.resScale} options={[[1, '100 %'], [0.75, '75 %'], [0.5, '50 %']]} pick={(v) => set('resScale', v)} />
      <Choice label="Clouds" value={s.clouds} options={[['high', 'High'], ['low', 'Low'], ['off', 'Off']]} pick={(v) => set('clouds', v)} />
      <Choice label="Bloom" value={s.bloom} options={ONOFF} pick={(v) => set('bloom', v)} />
      <Choice label="Lens flare" value={s.flare} options={ONOFF} pick={(v) => set('flare', v)} />
      <Choice label="FTL blur" value={s.ftlBlur} options={ONOFF} pick={(v) => set('ftlBlur', v)} />
      <button type="button" className="pmbtn setback" onClick={back}>
        <ArrowLeft weight="bold" /> Back
      </button>
    </div>
  );
}
