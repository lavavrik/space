/**
 * The ship's sound (docs/sound.md): all synthesised with Web Audio, no sound files. Each frame
 * `update` reads the game (audio/levels.ts) and steers a set of always-running layers (drive, attitude
 * thrusters, FTL, wind, laser…) by their gains and filters, and plays one-shots for changes (chimes,
 * knocks, alarms).
 *
 * Browsers only start audio after a click or key press, so the context starts suspended and
 * resumes on the first one. Shift+P turns the sound off and on (remembered in this browser).
 */
import type { Game } from '../Game';
import { cues, seenNow, soundLevels, type Cue, type Levels, type Seen } from './levels';

const MUTE_KEY = 'farlight.sound.off';
const VOLUME = 0.5;

type Layer = { gain: GainNode; filter?: BiquadFilterNode; osc?: OscillatorNode[] };

export class ShipAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private layers!: Record<'hum' | 'idle' | 'engine' | 'rcs' | 'ftlCharge' | 'ftl' | 'jumpCharge' | 'jump' | 'wind' | 'laser' | 'cutting' | 'grit', Layer>;
  private noise!: { white: AudioBuffer; brown: AudioBuffer };
  private seen: Seen | null = null;
  private lastMsg = { text: '', at: -1 };
  private beepT = 0;
  muted = false;

  constructor() {
    // one ship's sound per page: a game made again (a hot reload in development, say) closes the
    // last one's, which otherwise played on, beyond the mute key's reach
    const prev = (globalThis as { __farlightAudio?: ShipAudio }).__farlightAudio;
    prev?.dispose();
    (globalThis as { __farlightAudio?: ShipAudio }).__farlightAudio = this;
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* no storage: sound on */
    }
    addEventListener('pointerdown', this.wake);
    addEventListener('keydown', this.wake);
  }

  /** On the first gesture: build the graph (or resume it). */
  private wake = () => {
    if (!this.ctx) {
      try {
        this.build(new AudioContext());
      } catch {
        return; // no Web Audio: silent
      }
    }
    if (this.ctx!.state === 'suspended' && !document.hidden) void this.ctx!.resume();
  };

  toggleMute() {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* not remembered */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : VOLUME, this.ctx.currentTime, 0.05);
    return !this.muted;
  }

  /** Hidden tab: stop (and don't burn CPU); back: carry on. */
  visibility(hidden: boolean) {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  private build(ctx: AudioContext) {
    this.ctx = ctx;
    // a gentle compressor on the master: stacked layers and a bang don't clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : VOLUME;
    this.master.connect(comp);
    this.noise = { white: noiseBuffer(ctx, 'white'), brown: noiseBuffer(ctx, 'brown') };

    const L = (build: (out: GainNode) => Partial<Layer>): Layer => {
      const gain = ctx.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);
      return { gain, ...build(gain) };
    };
    this.layers = {
      // life support: a low mains-like hum and, barely, its fans (always there; the fans' noise was
      // loud enough to read as a hiss with the ship at rest)
      hum: L((out) => {
        const f = this.filter('lowpass', 300, 0.7, out);
        this.loop('brown', f, 0.15);
        return { osc: [this.osc('sine', 50, out, 0.25), this.osc('triangle', 100, out, 0.08)] };
      }),
      // the drive idling in normal space: a warbling, resonant hum (a nod to a certain delivery
      // ship's): two saws through a resonant low-pass whose cutoff and pitch wobble on slow LFOs
      idle: L((out) => {
        const f = this.filter('lowpass', 500, 9, out);
        const osc = [this.osc('sawtooth', 82, f, 0.3), this.osc('sawtooth', 123.5, f, 0.18), this.osc('sine', 41, out, 0.35)];
        this.lfo(5.5, 260, f.frequency); // the "wub"
        for (const o of osc) this.lfo(0.9, 14, o.detune); // a slow warble in pitch
        return { filter: f, osc };
      }),
      // the drive: deep rumble through the frame; brighter the harder it works
      engine: L((out) => {
        const f = this.filter('lowpass', 150, 1, out);
        this.loop('brown', f, 3);
        return { filter: f, osc: [this.osc('sawtooth', 38, f, 0.25), this.osc('sawtooth', 38.7, f, 0.2)] };
      }),
      // attitude thrusters: short gas hiss
      rcs: L((out) => {
        const f = this.filter('bandpass', 2400, 0.8, out);
        this.loop('white', f, 0.6);
        return { filter: f };
      }),
      // FTL charge: a whine climbing with the charge, with a tremolo
      ftlCharge: L((out) => ({ osc: [this.osc('sine', 120, out, 0.35), this.osc('triangle', 240, out, 0.12)] })),
      // FTL running: two detuned tones (the beat is the drive), pitch up with log speed, over a hollow roar
      ftl: L((out) => {
        const f = this.filter('bandpass', 300, 2, out);
        this.loop('brown', f, 2);
        return { filter: f, osc: [this.osc('sine', 70, out, 0.3), this.osc('sine', 70.8, out, 0.3)] };
      }),
      // hyperdrive charge: a deep swelling chord
      jumpCharge: L((out) => ({ osc: [this.osc('sawtooth', 45, this.filter('lowpass', 600, 1, out), 0.3), this.osc('sine', 90, out, 0.3)] })),
      // hyperspace: a roar
      jump: L((out) => {
        const f = this.filter('lowpass', 500, 1, out);
        this.loop('brown', f, 3);
        return { filter: f, osc: [this.osc('sine', 33, out, 0.4)] };
      }),
      // air past the hull: a band of noise that rises with speed
      wind: L((out) => {
        const f = this.filter('bandpass', 400, 0.6, out);
        this.loop('white', f, 0.8);
        return { filter: f };
      }),
      // the laser's power stage: an electric buzz
      laser: L((out) => {
        const f = this.filter('bandpass', 900, 3, out);
        return { osc: [this.osc('sawtooth', 120, f, 0.4), this.osc('square', 240.5, f, 0.15)] };
      }),
      // cutting rock: crackle
      cutting: L((out) => {
        const f = this.filter('highpass', 1500, 0.7, out);
        this.loop('white', f, 0.5);
        return {};
      }),
      // belt dust on the hull: a fine patter
      grit: L((out) => {
        const f = this.filter('highpass', 4000, 0.5, out);
        this.loop('white', f, 0.35);
        return {};
      }),
    };
  }

  private osc(type: OscillatorType, freq: number, to: AudioNode, level: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(to);
    o.start();
    return o;
  }

  /** Wobble `param` by ±depth at `rate` Hz. */
  private lfo(rate: number, depth: number, param: AudioParam) {
    const o = this.ctx!.createOscillator();
    o.frequency.value = rate;
    const g = this.ctx!.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    o.start();
  }

  private filter(type: BiquadFilterType, freq: number, Q: number, to: AudioNode) {
    const f = this.ctx!.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    f.connect(to);
    return f;
  }

  private loop(kind: 'white' | 'brown', to: AudioNode, level: number) {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise[kind];
    s.loop = true;
    // start each loop at a random point so layers sharing a buffer don't phase together
    s.start(0, Math.random() * s.buffer.duration);
    const g = ctx.createGain();
    g.gain.value = level;
    s.connect(g).connect(to);
  }

  /** Once per frame, after the simulation step. */
  update(g: Game, dt: number) {
    const ctx = this.ctx;
    const now = seenNow(g);
    const was = this.seen;
    this.seen = now;
    if (!ctx || ctx.state !== 'running' || this.muted) return;
    const v = soundLevels(g);
    this.steer(v, ctx.currentTime);
    if (was) for (const c of cues(was, now)) this.cue(c, g);
    // collision radar: a fast pip while a rock's on a collision course
    if (v.proximity && (this.beepT -= dt) <= 0) {
      this.beepT = 0.35;
      this.tone(1760, 0.06, 0.25, 'square');
    } else if (!v.proximity) this.beepT = 0;
  }

  private steer(v: Levels, t: number) {
    const set = (p: AudioParam, x: number, tau = 0.08) => p.setTargetAtTime(x, t, tau);
    const { layers: L } = this;
    set(L.hum.gain.gain, 0.12 * v.hum, 0.5);
    // the drive's warble: only while it works, louder and higher with thrust (at rest it droned on
    // as a constant "wawawa")
    set(L.idle.gain.gain, 0.16 * v.idle * v.engine, 0.3);
    set(L.idle.filter!.frequency, 420 + 900 * v.engine, 0.15);
    for (const [i, o] of L.idle.osc!.entries()) set(o.frequency, [82, 123.5, 41][i] * (1 + 0.25 * v.engine), 0.3);
    set(L.engine.gain.gain, 0.9 * v.engine, 0.1);
    set(L.engine.filter!.frequency, 120 + 700 * v.engine * v.engine);
    set(L.rcs.gain.gain, 0.35 * v.rcs, 0.03);
    // FTL charge: up an octave and a half over the charge, with a quickening tremolo
    const ch = v.ftlCharge;
    const trem = ch > 0 ? 0.75 + 0.25 * Math.sin(t * (8 + 30 * ch)) : 0;
    set(L.ftlCharge.gain.gain, 0.3 * (ch > 0 ? 0.3 + 0.7 * ch : 0) * trem, 0.02);
    for (const [i, o] of L.ftlCharge.osc!.entries()) set(o.frequency, (i + 1) * 120 * Math.pow(2, 2.5 * ch), 0.05);
    set(L.ftl.gain.gain, 0.3 * v.ftl, 0.2);
    const fp = 60 * Math.pow(2, 2 * v.ftlPitch);
    set(L.ftl.osc![0].frequency, fp, 0.3);
    set(L.ftl.osc![1].frequency, fp * 1.012, 0.3);
    set(L.ftl.filter!.frequency, 200 + 900 * v.ftlPitch, 0.3);
    set(L.jumpCharge.gain.gain, 0.4 * v.jumpCharge, 0.1);
    for (const o of L.jumpCharge.osc!) set(o.detune, 1200 * v.jumpCharge, 0.1);
    set(L.jump.gain.gain, 0.5 * v.jump, 0.6);
    set(L.jump.filter!.frequency, 300 + 400 * v.jump, 0.6);
    set(L.wind.gain.gain, 0.6 * v.wind, 0.2);
    set(L.wind.filter!.frequency, 250 + 2500 * v.windPitch, 0.2);
    set(L.laser.gain.gain, 0.12 * v.laser, 0.03);
    set(L.cutting.gain.gain, 0.15 * v.cutting * (0.6 + 0.4 * Math.random()), 0.02);
    set(L.grit.gain.gain, 0.2 * v.grit, 0.2);
  }

  private cue(c: Cue, g: Game) {
    switch (c.k) {
      case 'msg': {
        // the same line again within a couple of seconds (a repeated warning) stays quiet
        const t = this.ctx!.currentTime;
        if (g.msg.text === this.lastMsg.text && t - this.lastMsg.at < 2) return;
        this.lastMsg = { text: g.msg.text, at: t };
        if (c.kind === 'warn') {
          this.tone(880, 0.09, 0.18, 'square');
          this.tone(660, 0.12, 0.18, 'square', 0.12);
        } else if (c.kind === 'ftl') this.tone(1320, 0.12, 0.1, 'sine');
        else this.tone(1560, 0.05, 0.07, 'sine');
        return;
      }
      case 'target':
        this.tone(2400, 0.02, 0.05, 'sine');
        return;
      case 'granted':
        this.tone(784, 0.18, 0.15, 'sine');
        this.tone(1175, 0.3, 0.15, 'sine', 0.16);
        return;
      case 'docked':
        this.thud(0.5, 90);
        this.tone(1047, 0.25, 0.12, 'sine', 0.25);
        this.tone(1319, 0.25, 0.12, 'sine', 0.4);
        this.tone(1568, 0.5, 0.12, 'sine', 0.55);
        return;
      case 'launch':
        this.thud(0.35, 70);
        this.whoosh(0.25, 0.8, 800, 200);
        return;
      case 'catapult':
        this.thud(0.8, 45);
        this.whoosh(0.7, 2.5, 300, 2000);
        return;
      case 'ftlIn':
        this.whoosh(0.5, 1.2, 150, 3000);
        this.sweep(200, 50, 0.8, 0.4);
        return;
      case 'ftlOut':
        this.whoosh(0.4, 0.9, 2500, 150);
        this.sweep(60, 180, 0.5, 0.3);
        return;
      case 'ping':
        this.tone(1900, 1.2, 0.12, 'sine');
        return;
      case 'impact':
        this.thud(0.4 + 0.6 * c.size, 60 - 25 * c.size);
        this.whoosh(0.2 + 0.5 * c.size, 0.15 + 0.4 * c.size, 3000, 400);
        return;
      case 'death':
        this.thud(1, 30);
        this.whoosh(1, 3.5, 1200, 60);
        return;
    }
  }

  /** A short beep: freq Hz, `len` s, peak gain, after `delay` s. */
  private tone(freq: number, len: number, peak: number, type: OscillatorType, delay = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const e = ctx.createGain();
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(peak, t + 0.005);
    e.gain.setTargetAtTime(0, t + len * 0.6, len * 0.25);
    o.connect(e).connect(this.master);
    o.start(t);
    o.stop(t + len * 2 + 0.1);
  }

  /** A pitch glide (drive spinning up or down). */
  private sweep(from: number, to: number, len: number, peak: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + len);
    const e = ctx.createGain();
    e.gain.setValueAtTime(peak, t);
    e.gain.setTargetAtTime(0, t + len * 0.5, len * 0.3);
    o.connect(e).connect(this.master);
    o.start(t);
    o.stop(t + len * 2);
  }

  /** A knock through the frame: a falling low sine. */
  private thud(peak: number, freq: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq * 2, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.08);
    const e = ctx.createGain();
    e.gain.setValueAtTime(peak, t);
    e.gain.setTargetAtTime(0, t, 0.12);
    o.connect(e).connect(this.master);
    o.start(t);
    o.stop(t + 1);
  }

  /** A burst of noise through a filter gliding `from`→`to` Hz. */
  private whoosh(peak: number, len: number, from: number, to: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = this.noise.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.8;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + len);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(peak, t + Math.min(0.05, len * 0.2));
    e.gain.setTargetAtTime(0, t + len * 0.4, len * 0.25);
    s.connect(f).connect(e).connect(this.master);
    s.start(t, Math.random());
    s.stop(t + len * 1.5);
  }

  dispose() {
    removeEventListener('pointerdown', this.wake);
    removeEventListener('keydown', this.wake);
    void this.ctx?.close();
  }
}

/** Two seconds of noise: white, or brown (integrated white, a deep rumble). */
function noiseBuffer(ctx: AudioContext, kind: 'white' | 'brown') {
  const n = ctx.sampleRate * 2;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'white') d[i] = w;
    else {
      b = (b + 0.02 * w) / 1.02;
      d[i] = b * 3.5;
    }
  }
  return buf;
}
