import type { ReactElement } from 'react';
import type { ModuleIcon } from '../../game/hud/types';

/*
 * Line drawings of the ship's modules, for the outfit tiles and cards: one per kind, on a 40 × 40
 * grid, stroked in the text colour (currentColor) with a faint fill where a part is solid. Drawn to
 * read at 28–44 px: a few bold shapes, no fine detail.
 */

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const SOLID = { fill: 'currentColor', fillOpacity: 0.14 } as const;

const ART: Record<ModuleIcon, ReactElement> = {
  // fuel scoop: a ram intake funnel, gas streaming in, a tank behind
  scoop: (
    <>
      <path d="M4 10 L18 16 L18 24 L4 30 Z" {...SOLID} />
      <path d="M4 10 L18 16 L18 24 L4 30" />
      <rect x={18} y={14} width={17} height={12} rx={3} {...SOLID} />
      <rect x={18} y={14} width={17} height={12} rx={3} />
      <path d="M1 15 H7 M1 20 H9 M1 25 H7" strokeDasharray="2 2" />
    </>
  ),
  // radiators: two fin panels folded out from the hull, with heat lines
  radiator: (
    <>
      <rect x={17} y={6} width={6} height={28} rx={2} {...SOLID} />
      <rect x={17} y={6} width={6} height={28} rx={2} />
      <path d="M17 10 L4 6 L4 34 L17 30 M23 10 L36 6 L36 34 L23 30" />
      <path d="M8 12 V28 M12 13 V27 M28 13 V27 M32 12 V28" strokeWidth={1} opacity={0.7} />
    </>
  ),
  // heat pump: a fan in a housing, heat carried out
  heatpump: (
    <>
      <circle cx={17} cy={20} r={12} {...SOLID} />
      <circle cx={17} cy={20} r={12} />
      <path d="M17 20 C17 13 21 11 23 13 M17 20 C23 21 24 26 21 27 M17 20 C12 24 9 22 10 19" />
      <circle cx={17} cy={20} r={1.8} fill="currentColor" />
      <path d="M31 14 H38 M35 11 L38 14 L35 17 M31 26 H38 M35 23 L38 26 L35 29" />
    </>
  ),
  // magnetic deflector: the ship inside nested field arcs, dust turned aside
  deflector: (
    <>
      <path d="M10 20 L20 15 L30 20 L20 25 Z" {...SOLID} />
      <path d="M10 20 L20 15 L30 20 L20 25 Z" />
      <path d="M6 12 C12 5 28 5 34 12 M3 17 C10 6 30 6 37 17" />
      <path d="M6 28 C12 35 28 35 34 28" opacity={0.6} />
      <circle cx={9} cy={4} r={1.2} fill="currentColor" />
      <circle cx={31} cy={3} r={1.2} fill="currentColor" />
    </>
  ),
  // collision radar: a dish sweeping, a rock picked out ahead
  guard: (
    <>
      <path d="M6 34 L14 26" />
      <path d="M8 22 A12 12 0 0 1 22 36 Z" {...SOLID} />
      <path d="M8 22 A12 12 0 0 1 22 36 Z" />
      <path d="M17 17 A16 16 0 0 1 27 27 M20 11 A22 22 0 0 1 33 24" opacity={0.75} />
      <path d="M30 6 L34 7 L35 11 L31 13 L28 10 Z" {...SOLID} />
      <path d="M30 6 L34 7 L35 11 L31 13 L28 10 Z" />
    </>
  ),
  // mining laser: an emitter, its beam, and a rock breaking up
  laser: (
    <>
      <rect x={3} y={15} width={11} height={10} rx={2} {...SOLID} />
      <rect x={3} y={15} width={11} height={10} rx={2} />
      <path d="M14 20 H27" strokeWidth={2.4} />
      <path d="M28 12 L36 14 L37 24 L30 29 L26 22 Z" {...SOLID} />
      <path d="M28 12 L36 14 L37 24 L30 29 L26 22 Z" />
      <path d="M24 14 L22 11 M24 26 L22 29 M20 16 L18 14" strokeWidth={1.2} />
    </>
  ),
  // fuel cell: a stack of plates, hydrogen and oxygen in, power out
  fuelcell: (
    <>
      <rect x={10} y={9} width={20} height={22} rx={2} {...SOLID} />
      <rect x={10} y={9} width={20} height={22} rx={2} />
      <path d="M14 9 V31 M18 9 V31 M22 9 V31 M26 9 V31" strokeWidth={1} opacity={0.7} />
      <path d="M2 15 H10 M7 12 L10 15 L7 18 M2 25 H10 M7 22 L10 25 L7 28" />
      <path d="M33 14 L36 20 L33 20 L36 26" strokeWidth={1.9} />
    </>
  ),
  // battery: a cell with a bolt
  battery: (
    <>
      <rect x={6} y={11} width={26} height={18} rx={3} {...SOLID} />
      <rect x={6} y={11} width={26} height={18} rx={3} />
      <path d="M32 17 H35 V23 H32" />
      <path d="M20 13 L15 21 H20 L18 27 L24 18 H19 Z" fill="currentColor" fillOpacity={0.5} />
    </>
  ),
  // an empty slot: a dashed bay with a plus
  empty: (
    <>
      <rect x={6} y={6} width={28} height={28} rx={4} strokeDasharray="4 3" opacity={0.6} />
      <path d="M20 14 V26 M14 20 H26" opacity={0.6} />
    </>
  ),
};

export function ModuleArt({ icon, size = 36 }: { icon: ModuleIcon; size?: number }) {
  return (
    <svg className="mart" viewBox="0 0 40 40" width={size} height={size} aria-hidden="true" {...S}>
      {ART[icon]}
    </svg>
  );
}
