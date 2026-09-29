/**
 * Station contracts (docs/economy.md, "Contracts"): a job board at every station, and your jobs.
 *
 *   - haul: sealed crates (5–60 t) to another station, in this system or one nearby. They go in
 *     the hold (Ship.crates: they count in its mass and use its room) and are paid for on docking
 *     at the destination.
 *   - courier: a data packet (no mass) to a station in another system, against a tight deadline,
 *     so paid better per light year; paid on docking there.
 *   - metal: this station wants an amount of one metal, at 2–3× its list price; handed over from
 *     the hold here (the contracts window's "deliver").
 *
 * The board is the same for everyone who looks, for BOARD_S of sim time (a hash of the station and
 * the period), then a new one. A job you've taken or finished doesn't come back on that board.
 * You hold up to MAX_ACTIVE. A job past its deadline fails: its crates are taken back (returned to
 * the client) and you pay PENALTY of its reward, as far as your credits go. Losing the ship loses
 * the crates, so hauls fail too; couriers and metal orders carry on.
 */
import type { Game } from '../Game';
import { JUMP_RANGE, AU } from '../constants';
import { mulberry32 } from '../lib/rng';
import type { StarSystem, Station } from '../types';
import { buildStations } from '../universe/stations';
import { buildSystem } from '../universe/system';
import { systemById } from '../universe/galaxy';
import { CARGO_CAP, COMMODITIES, cargoMass, fmtCr, type Commodity } from './economy';

export type ContractKind = 'haul' | 'courier' | 'metal';

export interface Place {
  sys: string; // system id
  sysName: string;
  station: string;
}

export interface Contract {
  id: string;
  kind: ContractKind;
  client: string;
  /** What's carried: crates' contents (haul), "sealed data" (courier), or the metal wanted. */
  what: string;
  from: Place;
  to: Place;
  /** kg: crates (haul) or metal wanted (metal); 0 for a courier. */
  kg: number;
  commodity?: Commodity;
  reward: number;
  /** Sim time it must be done by (s); on the board, how long it allows from accepting. */
  deadline: number;
  allow: number;
}

/** A board lasts this long (s of sim time); jobs held at once; the share of a job's reward a failure costs. */
export const BOARD_S = 1800,
  MAX_ACTIVE = 3,
  PENALTY = 0.25,
  OFFERS = 4;
/** Jobs to other systems go this far at most (ly). */
const FAR_LY = Math.min(15, JUMP_RANGE);

const GOODS = ['machine parts', 'medical supplies', 'hydroponics kits', 'reactor spares', 'survey drones', 'fine foods', 'mining charges', 'water purifiers', 'textiles', 'optics'];
const CLIENT_A = ['Halvorsen', 'Okafor', 'Meridian', 'Tessaly', 'Brightwater', 'Kestrel', 'Anand', 'Volkov', 'Sunderland', 'Ivers'];
const CLIENT_B = ['Freight', 'Logistics', 'Mining Co.', 'Medical', 'Holdings', 'Couriers', 'Works', 'Trading'];

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Other systems' stations, by system id (built once each: the same as arriving there would build). */
const stationCache = new Map<string, Station[]>();
function stationsOf(g: Game, sys: StarSystem): Station[] {
  if (sys.id === g.cur.sys.id) return g.cur.stations;
  let s = stationCache.get(sys.id);
  if (!s) stationCache.set(sys.id, (s = buildStations(sys, buildSystem(sys))));
  return s;
}

const placeOf = (sys: StarSystem, st: Station): Place => ({ sys: sys.id, sysName: sys.name, station: st.name });
const epochOf = (t: number) => Math.floor(t / BOARD_S);

/** The board at `st` (this system) right now: what's on offer, less the jobs you've taken or done. */
export function board(g: Game, st: Station): Contract[] {
  const sys = g.cur.sys;
  const epoch = epochOf(g.simTime);
  const rng = mulberry32(hashStr(`${sys.id}/${st.name}/${epoch}`));
  const pick = <T>(a: readonly T[]) => a[Math.floor(rng() * a.length) % a.length];
  const here = placeOf(sys, st);
  const others = g.cur.stations.filter((s) => s !== st);
  const far = g.nearby.filter((s) => s.pos.distanceTo(sys.pos) <= FAR_LY);
  const out: Contract[] = [];
  for (let i = 0; i < OFFERS; i++) {
    const id = `${sys.id}/${st.name}/${epoch}/${i}`;
    const client = `${pick(CLIENT_A)} ${pick(CLIENT_B)}`;
    const roll = rng();
    let c: Contract | null = null;
    if (roll < 0.25) {
      // a metal order: this station's own
      const commodity = pick(['cobalt', 'cobalt', 'pgm', 'nife'] as const);
      const kg = Math.round((commodity === 'pgm' ? 200 + 1800 * rng() : commodity === 'cobalt' ? 2000 + 13000 * rng() : 20000 + 60000 * rng()) / 100) * 100;
      const reward = Math.round(kg * COMMODITIES[commodity].price * (2 + rng()) + 500);
      c = { id, kind: 'metal', client, what: COMMODITIES[commodity].name.toLowerCase(), from: here, to: here, kg, commodity, reward, deadline: 0, allow: 3600 * (2 + 2 * rng()) };
    } else if (roll < 0.45 && far.length) {
      // a courier run to another system: no mass, a tight clock
      const sys2 = pick(far);
      const st2 = pick(stationsOf(g, sys2));
      if (!st2) continue;
      const ly = sys2.pos.distanceTo(sys.pos);
      c = { id, kind: 'courier', client, what: 'a sealed data packet', from: here, to: placeOf(sys2, st2), kg: 0, reward: Math.round((3000 + 1500 * ly) / 50) * 50, deadline: 0, allow: 600 + 150 * ly };
    } else {
      // a haul: in the system, or to one nearby
      const away = far.length > 0 && (rng() < 0.4 || !others.length);
      const sys2 = away ? pick(far) : sys;
      const st2 = away ? pick(stationsOf(g, sys2)) : pick(others);
      if (!st2) continue;
      const tons = Math.round(5 + 55 * rng() ** 1.5);
      const dist = away ? sys2.pos.distanceTo(sys.pos) : 0;
      const au = away ? 0 : Math.max(0.05, st.pos.distanceTo(st2.pos) / AU);
      const reward = away ? 4000 + 1200 * dist + 60 * tons : 1500 + 1500 * au + 40 * tons;
      c = { id, kind: 'haul', client, what: pick(GOODS), from: here, to: placeOf(sys2, st2), kg: tons * 1000, reward: Math.round(reward / 50) * 50, deadline: 0, allow: away ? 1500 + 300 * dist : 1200 + 300 * au };
    }
    if (c && !g.contractsSeen.has(id)) out.push(c);
  }
  return out;
}

/** Why you can't take it (or null): too many jobs, or no room in the hold for its crates. */
export function cantTake(g: Game, c: Contract): string | null {
  if (g.contracts.length >= MAX_ACTIVE) return `you hold ${MAX_ACTIVE} jobs already`;
  if (c.kind === 'haul' && cargoMass(g) + c.kg > CARGO_CAP) return `needs ${Math.round(c.kg / 1000)} t of room in the hold`;
  return null;
}

/** Take a job off the board at the station you're docked at. */
export function accept(g: Game, c: Contract) {
  const why = cantTake(g, c);
  if (why) {
    g.showMsg(`Can't take it · ${why}`, 'warn');
    return;
  }
  const job = { ...c, deadline: g.simTime + c.allow };
  g.contracts.push(job);
  g.contractsSeen.add(c.id);
  if (c.kind === 'haul') g.ship.crates[c.id] = c.kg;
  g.showMsg(
    c.kind === 'metal'
      ? `Accepted · ${fmtKg(c.kg)} of ${c.what} for ${c.from.station} · ${fmtCr(c.reward)}`
      : `Accepted · ${c.kind === 'haul' ? `${fmtKg(c.kg)} of ${c.what} loaded` : 'packet aboard'} · to ${c.to.station}${c.to.sys !== g.cur.sys.id ? ` (${c.to.sysName})` : ''} · ${fmtCr(c.reward)}`,
  );
}

const fmtKg = (kg: number) => (kg >= 1000 ? `${Math.round(kg / 100) / 10} t` : `${Math.round(kg)} kg`);

function finish(g: Game, c: Contract) {
  g.contracts = g.contracts.filter((x) => x !== c);
  delete g.ship.crates[c.id];
}

/** Drop a job: as a failure (the penalty is paid). */
export function abandon(g: Game, c: Contract, why = 'abandoned') {
  finish(g, c);
  const fine = Math.min(g.credits, c.reward * PENALTY);
  g.credits -= fine;
  g.showMsg(`Contract ${why} · ${c.client} · ${c.to.station} · penalty ${fmtCr(fine)}`, 'warn');
}

/** A metal order: hand the metal over from the hold (docked at its station, with enough). */
export function deliverMetal(g: Game, c: Contract) {
  if (!canDeliverMetal(g, c)) return;
  g.ship.cargo[c.commodity!] = (g.ship.cargo[c.commodity!] ?? 0) - c.kg;
  if ((g.ship.cargo[c.commodity!] ?? 0) < 0.5) delete g.ship.cargo[c.commodity!];
  finish(g, c);
  g.credits += c.reward;
  g.showMsg(`Delivered ${fmtKg(c.kg)} of ${c.what} · ${c.client} pays ${fmtCr(c.reward)}`);
}

export function canDeliverMetal(g: Game, c: Contract) {
  return c.kind === 'metal' && atPlace(g, c.to) && (g.ship.cargo[c.commodity!] ?? 0) >= c.kg;
}

/** Docked at this place? */
export const atPlace = (g: Game, p: Place) => !!g.dock?.docked && g.cur.sys.id === p.sys && g.dock.station.name === p.station;

/**
 * Each frame: deliveries on docking at their destination, and deadlines. (Hauls and couriers pay
 * on docking; metal is handed over by hand.)
 */
export function updateContracts(g: Game) {
  for (const c of [...g.contracts]) {
    if (c.kind !== 'metal' && atPlace(g, c.to)) {
      finish(g, c);
      g.credits += c.reward;
      g.showMsg(`Delivered · ${c.what} for ${c.client} · paid ${fmtCr(c.reward)}`);
    } else if (g.simTime > c.deadline) abandon(g, c, 'failed: out of time');
    else if (c.deadline - g.simTime < 300 && !g.warned[`job:${c.id}`]) {
      g.warned[`job:${c.id}`] = true;
      g.showMsg(`Five minutes left · ${c.to.station}${c.to.sys !== g.cur.sys.id ? ` in ${c.to.sysName}` : ''}`, 'warn');
    }
  }
  // forget boards more than one period old (their jobs can't be offered again anyway)
  const epoch = epochOf(g.simTime);
  for (const id of g.contractsSeen) if (+id.split('/')[2] < epoch - 1) g.contractsSeen.delete(id);
}

/** The ship lost: its crates with it, so its hauls fail. */
export function shipLost(g: Game) {
  for (const c of [...g.contracts]) if (c.kind === 'haul') abandon(g, c, 'failed: the crates were lost with the ship');
}

/** The system a job's destination is in (for the nav computer). */
export const destSystem = (c: Contract) => systemById(c.to.sys);

/** How far a job goes, for the board: "in system · 1.2 AU" or "6.3 ly". */
export function reach(g: Game, c: Contract) {
  if (c.to.sys === g.cur.sys.id) {
    const st = g.cur.stations.find((s) => s.name === c.to.station);
    const here = g.dock?.station ?? null;
    return st && here ? `${(st.pos.distanceTo(here.pos) / AU).toFixed(2)} AU` : 'in this system';
  }
  const s = systemById(c.to.sys);
  return s ? `${s.pos.distanceTo(g.cur.sys.pos).toFixed(1)} ly` : ''; // (systems' positions are in ly)
}
