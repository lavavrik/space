import { AU, C, LY } from './constants';

export const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtDist(m: number) {
  const a = Math.abs(m);
  if (a < 1e4) return nf0.format(m) + ' m';
  if (a < 1e9) return nf0.format(m / 1e3) + ' km';
  if (a < 0.5 * LY) return (m / AU).toFixed(a < 10 * AU ? 3 : 2) + ' AU';
  return (m / LY).toFixed(2) + ' ly';
}

export function fmtCoord(m: number) {
  const a = Math.abs(m);
  const s = m < 0 ? '−' : '+';
  if (a < 1e9) return s + nf0.format(a / 1e3) + ' km';
  return s + (a / AU).toFixed(4) + ' AU';
}

/** Returns [value, unit]. */
export function fmtSpeed(v: number): [string, string] {
  if (v < 1000) return [v.toFixed(0), 'M/S'];
  if (v < 0.01 * C) return [(v / 1000).toFixed(v < 1e4 ? 2 : v < 1e5 ? 1 : 0), 'KM/S'];
  return [(v / C).toFixed(v < 10 * C ? 2 : v < 100 * C ? 1 : 0), 'TIMES LIGHT SPEED (C)'];
}

/** Speed as one lower-case string, e.g. "1.25 km/s". */
export const fmtSpeedText = (v: number) => fmtSpeed(v).join(' ').toLowerCase();

export function fmtFlow(kgs: number) {
  if (kgs < 0.01) return '0 kg/s';
  if (kgs < 1) return `${(kgs * 3600).toFixed(0)} kg/h`;
  return `${kgs < 100 ? kgs.toFixed(1) : nf0.format(kgs)} kg/s`;
}

export function fmtMass(kg: number) {
  return kg >= 1000 ? `${(kg / 1000).toFixed(1)} t` : `${kg.toFixed(kg < 10 ? 2 : 1)} kg`;
}

export function fmtTime(s: number) {
  if (s > 360000 && isFinite(s)) return `${Math.round(s / 86400)} days`;
  if (!isFinite(s)) return '—';
  s = Math.round(s);
  const h = Math.floor(s / 3600),
    m = Math.floor(s / 60) % 60,
    ss = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function fmtPower(kw: number) {
  return kw >= 1000 ? `${(kw / 1000).toFixed(kw < 1e4 ? 2 : 1)} MW` : `${kw.toFixed(kw < 10 ? 1 : 0)} kW`;
}

/** mm:ss clock for the sim time. */
export function fmtClock(seconds: number) {
  const t = Math.floor(seconds);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
