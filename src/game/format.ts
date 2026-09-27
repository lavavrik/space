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
  return [(v / C).toFixed(v < 10 * C ? 2 : v < 100 * C ? 1 : 0), 'c']; // multiples of light speed
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

/**
 * Power, always with the same precision: 9.5 kW, 640 kW, 1.00 MW, 12.5 MW. The unit is picked after
 * rounding, so 999.7 kW reads 1.00 MW rather than "1000 kW".
 */
export function fmtPower(kw: number) {
  const a = Math.abs(kw);
  if (a < 9.95) return `${kw.toFixed(1)} kW`;
  if (a < 999.5) return `${kw.toFixed(0)} kW`;
  const mw = kw / 1000,
    m = Math.abs(mw);
  return `${mw.toFixed(m < 9.995 ? 2 : m < 99.95 ? 1 : 0)} MW`;
}

/** Energy in the same style: 6.0 kWh, 200 kWh, 1.20 MWh. */
export function fmtEnergy(kwh: number) {
  return fmtPower(kwh) + 'h';
}

/** Mission clock: mm:ss, then h:mm:ss, then days (time warp runs it up fast). */
export function fmtClock(seconds: number) {
  const t = Math.floor(seconds);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const s = t % 60,
    m = Math.floor(t / 60) % 60,
    h = Math.floor(t / 3600) % 24,
    d = Math.floor(t / 86400);
  if (t < 3600) return `${p2(Math.floor(t / 60))}:${p2(s)}`;
  if (d === 0) return `${h}:${p2(m)}:${p2(s)}`;
  return `day ${d + 1} · ${h}:${p2(m)}`;
}

/** An area in m², e.g. "2,400 m²". */
export const fmtArea = (m2: number) => `${nf0.format(Math.round(m2))} m²`;
