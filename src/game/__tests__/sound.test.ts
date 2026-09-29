import { describe, expect, it } from 'vitest';
import type { Game } from '../Game';
import { cues, seenNow, soundLevels, type Seen } from '../audio/levels';

/** Just what the sound reads. */
function fake(over: Record<string, unknown> = {}): Game {
  return {
    ship: { dead: null, mode: 'normal', throttle: 0, ftlSpeed: 0, ftlCharge: 0, landed: null, hull: 1 },
    power: { thrustKW: 0, turnKW: 0, laserKW: 0 },
    aero: { body: null, rho: 0, speed: 0 },
    jump: null,
    laser: { on: false, hit: null, removal: 0 },
    erosion: 0,
    rockThreat: null,
    dock: null,
    ascent: null,
    radar: { sweep: 0 },
    target: null,
    msg: { text: '', kind: '' },
    ...over,
  } as unknown as Game;
}
const seen = (s: Partial<Seen>): Seen => ({ msg: null, hull: 1, dead: false, ftl: false, dock: null, docked: false, ascent: false, sweep: false, target: null, ...s });

describe('sound levels', () => {
  it('tells the drive from the attitude thrusters', () => {
    const turning = soundLevels(fake({ power: { thrustKW: 10, turnKW: 10, laserKW: 0 } }));
    expect(turning.engine).toBe(0);
    expect(turning.rcs).toBeGreaterThan(0.5);
    const burning = soundLevels(fake({ power: { thrustKW: 480, turnKW: 0, laserKW: 0 } }));
    expect(burning.engine).toBeCloseTo(1);
    expect(burning.rcs).toBe(0);
  });

  it('hums while flying in normal space, not docked, landed or in FTL', () => {
    expect(soundLevels(fake()).idle).toBe(1);
    expect(soundLevels(fake({ dock: { docked: true } })).idle).toBe(0);
    expect(soundLevels(fake({ ship: { ...fake().ship, landed: {} } })).idle).toBe(0);
    const ftl = soundLevels(fake({ ship: { ...fake().ship, mode: 'ftl', ftlSpeed: 1e11, throttle: 1 } }));
    expect(ftl.idle).toBe(0);
    expect(ftl.ftl).toBe(1);
    expect(ftl.ftlPitch).toBeGreaterThan(0.5);
  });

  it('only has wind in an atmosphere, rising with dynamic pressure', () => {
    expect(soundLevels(fake({ aero: { body: null, rho: 1, speed: 300 } })).wind).toBe(0);
    const slow = soundLevels(fake({ aero: { body: {}, rho: 1, speed: 50 } })).wind;
    const fast = soundLevels(fake({ aero: { body: {}, rho: 1, speed: 300 } })).wind;
    expect(slow).toBeGreaterThan(0);
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeLessThanOrEqual(1);
  });

  it('goes quiet when the ship is lost', () => {
    const v = soundLevels(fake({ ship: { ...fake().ship, dead: { t: 1 } }, power: { thrustKW: 480, turnKW: 0, laserKW: 0 } }));
    expect(v.hum + v.engine + v.idle).toBe(0);
  });
});

describe('sound cues', () => {
  it('knocks on a hit, sized by the hull lost; wear is silent', () => {
    expect(cues(seen({ hull: 1 }), seen({ hull: 0.999 }))).toEqual([]);
    const [c] = cues(seen({ hull: 1 }), seen({ hull: 0.95 }));
    expect(c).toEqual({ k: 'impact', size: expect.closeTo(0.5, 5) });
    expect(cues(seen({ hull: 0.3 }), seen({ hull: 0, dead: true }))).toEqual([{ k: 'death' }]);
  });

  it('chimes for docking, and tells a catapult from a launch', () => {
    const dock = {};
    expect(cues(seen({}), seen({ dock }))).toEqual([{ k: 'granted' }]);
    expect(cues(seen({ dock }), seen({ dock, docked: true }))).toEqual([{ k: 'docked' }]);
    expect(cues(seen({ dock, docked: true }), seen({}))).toEqual([{ k: 'launch' }]);
    expect(cues(seen({ dock, docked: true }), seen({ ascent: true }))).toEqual([{ k: 'catapult' }]);
  });

  it("a message chimes only when nothing louder happens", () => {
    const msg = { kind: 'warn' };
    expect(cues(seen({}), seen({ msg }))).toEqual([{ k: 'msg', kind: 'warn' }]);
    expect(cues(seen({}), seen({ msg, ftl: true }))).toEqual([{ k: 'ftlIn' }]);
  });

  it('reads the game state', () => {
    const s = seenNow(fake({ dock: { docked: true } }));
    expect(s.docked).toBe(true);
    expect(s.ftl).toBe(false);
  });
});
