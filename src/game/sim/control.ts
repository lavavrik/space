/**
 * Station traffic control (docs/docking.md, "Traffic control"): pads and the slot, shared by every
 * ship: yours and the others (sim/traffic.ts), which fly the same code in their own pilot contexts.
 *
 *   - Pads: a request is only granted a pad no other ship holds (granted or docked on). With all
 *     taken, the request waits and asks again (updateDockRequest).
 *   - The slot, one ship at a time: a docking computer arriving holds short of the station until
 *     the slot is clear; one leaving waits on the hangar's axis until it is. Ships waiting to go in
 *     hold on the slot's axis in a queue (first come, first served), each SLOT_QUEUE further out
 *     than the one ahead, not all on the hold point.
 *
 * Nothing is booked: who holds which pad and who's in the slot are read off every pilot's state
 * each time they're asked (its dock, its docking computer's phase), so nothing can go stale when a
 * ship is lost, gives up or leaves.
 */
import type { Game } from '../Game';
import type { Station } from '../types';
import { pilotOf } from './traffic';
import { padCount } from './stationGeom';

/** Spacing of the queue for the slot, along its axis beyond the hold point (m). */
export const SLOT_QUEUE = 400;

/** The game itself, from any pilot context (a context is Object.create(game): the game owns `traffic`). */
export const rootOf = (g: Game): Game => (Object.prototype.hasOwnProperty.call(g, 'traffic') ? g : (Object.getPrototypeOf(g) as Game));

/** Every pilot: you, then each other ship's context. Made once per sim step (it's asked often). */
let cache: { root: Game; t: number; n: number; list: Game[] } | null = null;
export function pilots(g: Game): Game[] {
  const root = rootOf(g);
  if (cache && cache.root === root && cache.t === root.simTime && cache.n === root.traffic.length) return cache.list;
  const out = [root];
  for (const npc of root.traffic) {
    const c = pilotOf(npc);
    if (c && !c.ship.dead) out.push(c);
  }
  cache = { root, t: root.simTime, n: root.traffic.length, list: out };
  return out;
}

/** Pads at `st` no other ship holds (granted or docked), for `self`. */
export function freePads(g: Game, st: Station): number[] {
  const held = new Set<number>();
  for (const p of pilots(g)) if (p.ship !== g.ship && p.dock?.station === st) held.add(p.dock.pad);
  const out: number[] = [];
  for (let i = 0; i < padCount(st); i++) if (!held.has(i)) out.push(i);
  return out;
}

/**
 * Is this pilot using `st`'s slot: its docking computer lining up, going in or coming out, or
 * (flying by hand) inside the station and not yet docked?
 */
function inSlot(p: Game, st: Station) {
  const ad = p.autodock;
  if (ad && (p.dock?.station ?? p.autodockStation) === st) return ad.phase === 'align' || ad.phase === 'enter' || ad.phase === 'exit';
  return p.inStation === st && !p.dock?.docked;
}

/** Another ship in `st`'s slot, if any (for `g`: it can't go yet). */
export function slotUser(g: Game, st: Station): Game | null {
  if (st.sky) return null; // an open deck: no slot
  for (const p of pilots(g)) if (p.ship !== g.ship && inSlot(p, st)) return p;
  return null;
}

/** A name for a pilot, in messages: "your ship" or the other ship's. */
export function pilotName(g: Game, p: Game) {
  const root = rootOf(g);
  if (p === root) return 'your ship';
  const npc = root.traffic.find((n) => pilotOf(n) === p);
  return npc ? `the ${npc.cls.toLowerCase()} ${npc.name}` : 'a ship';
}

/**
 * Where `g` is in the queue for `st`'s slot (0 = next): arrivals waiting for it, ordered by how
 * long they've waited.
 */
export function queuePlace(g: Game, st: Station): number {
  const mine = g.autodock?.waitSince ?? Infinity;
  let n = 0;
  for (const p of pilots(g)) {
    if (p.ship === g.ship || (p.dock?.station ?? p.autodockStation) !== st) continue;
    const w = p.autodock?.phase === 'hold' ? p.autodock.waitSince : undefined;
    if (w !== undefined && w < mine) n++;
  }
  return n;
}
