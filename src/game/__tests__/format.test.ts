import { describe, expect, it } from 'vitest';
import { AU, C, LY } from '../constants';
import { fmtClock, fmtCoord, fmtDist, fmtFlow, fmtMass, fmtPower, fmtSpeed, fmtTime } from '../format';

describe('formatting', () => {
  it('picks distance units by scale', () => {
    expect(fmtDist(950)).toBe('950 m');
    expect(fmtDist(16_245_000)).toBe('16,245 km');
    expect(fmtDist(2 * AU)).toBe('2.000 AU');
    expect(fmtDist(4.98 * LY)).toBe('4.98 ly');
  });

  it('signs coordinates', () => {
    expect(fmtCoord(-1.17 * AU)).toBe('−1.1700 AU');
    expect(fmtCoord(224_646_000)).toBe('+224,646 km');
  });

  it('switches speed to km/s and multiples of c', () => {
    expect(fmtSpeed(334)).toEqual(['334', 'M/S']);
    expect(fmtSpeed(4030)).toEqual(['4.03', 'KM/S']);
    expect(fmtSpeed(2.5 * C)).toEqual(['2.50', 'c']);
  });

  it('formats times, masses, flows and power', () => {
    expect(fmtTime(75)).toBe('01:15');
    expect(fmtTime(5640)).toBe('1h 34m');
    expect(fmtTime(52 * 86400)).toBe('52 days');
    expect(fmtTime(Infinity)).toBe('—');
    expect(fmtMass(120e3)).toBe('120.0 t');
    expect(fmtMass(2.5)).toBe('2.50 kg');
    expect(fmtFlow(0.5)).toBe('1800 kg/h');
    expect(fmtFlow(24.3)).toBe('24.3 kg/s');
    expect(fmtPower(6000)).toBe('6.00 MW');
    expect(fmtPower(40)).toBe('40 kW');
    expect(fmtClock(342.7)).toBe('05:42');
    expect(fmtClock(3 * 3600 + 5 * 60 + 9)).toBe('3:05:09');
    expect(fmtClock(2 * 86400 + 7 * 3600 + 30 * 60)).toBe('day 3 · 7:30');
  });
});
