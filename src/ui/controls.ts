/** Control groups: each colours its keys on the keyboard schema and has its own legend block. */
export type ControlGroup = 'flight' | 'ftl' | 'target' | 'ship' | 'planner';

export const GROUPS: { id: ControlGroup; title: string; keys: [string, string][] }[] = [
  {
    id: 'flight',
    title: 'FLIGHT',
    keys: [
      ['W S', 'fwd / back'],
      ['A D', 'strafe'],
      ['Spc C', 'up / down'],
      ['Mouse', 'steer (or arrows)'],
      ['Q E', 'roll'],
      ['Shift', 'boost'],
      ['X', 'all stop'],
      ['Z', 'flight assist'],
      ['V', 'decouple'],
    ],
  },
  {
    id: 'ftl',
    title: 'FTL & JUMPS',
    keys: [
      ['J', 'FTL on / off'],
      ['W S', 'FTL throttle'],
      ['F', 'cruise control'],
      ['N', 'pick star'],
      ['H', 'hyperjump'],
    ],
  },
  {
    id: 'target',
    title: 'TARGETING',
    keys: [
      ['T', 'target ahead'],
      ['G', 'next nearest'],
      ['Click', 'target it'],
      ['Y', 'scan target'],
      ['I', 'target info'],
      ['U', 'avionics'],
    ],
  },
  {
    id: 'ship',
    title: 'SHIP',
    keys: [
      ['O', 'orbit planner / autopilot'],
      ['⌫ ⌫', 'disengage autopilot'],
      ['P', 'sun-track panels'],
      ['K', 'fuel tanker'],
      ['Tab', 'hide controls'],
      ['`', 'performance'],
    ],
  },
  {
    id: 'planner',
    title: 'ORBIT PLANNER',
    keys: [
      ['1–4', 'orbit type'],
      ['[ ]', 'altitude'],
      ['R', 'direction'],
      ['L', 'preview ring'],
      ['⏎', 'engage'],
    ],
  },
];

/** One keycap on the schema: label, width in key units, and the group it belongs to (if any). */
export type Keycap = [label: string, width: number, group?: ControlGroup];

/**
 * A compact keyboard, row by row, with only the keys the game uses coloured. W/S are 'flight'
 * though they also set the FTL throttle; the legend lists both.
 */
export const KEYBOARD: Keycap[][] = [
  [['`', 1.25, 'ship'], ['1', 1, 'planner'], ['2', 1, 'planner'], ['3', 1, 'planner'], ['4', 1, 'planner'], ['5', 1], ['6', 1], ['7', 1], ['8', 1], ['9', 1], ['0', 1]],
  [['Tab', 1.5, 'ship'], ['Q', 1, 'flight'], ['W', 1, 'flight'], ['E', 1, 'flight'], ['R', 1, 'planner'], ['T', 1, 'target'], ['Y', 1, 'target'], ['U', 1, 'target'], ['I', 1, 'target'], ['O', 1, 'ship'], ['P', 1, 'ship'], ['[', 1, 'planner'], [']', 1, 'planner']],
  [['Caps', 1.75], ['A', 1, 'flight'], ['S', 1, 'flight'], ['D', 1, 'flight'], ['F', 1, 'ftl'], ['G', 1, 'target'], ['H', 1, 'ftl'], ['J', 1, 'ftl'], ['K', 1, 'ship'], ['L', 1, 'planner'], ['⏎', 1.5, 'planner']],
  [['Shift', 2.25, 'flight'], ['Z', 1, 'flight'], ['X', 1, 'flight'], ['C', 1, 'flight'], ['V', 1, 'flight'], ['B', 1], ['N', 1, 'ftl'], ['M', 1], ['↑', 1, 'flight']],
  [['Ctrl', 1.5, 'flight'], ['Space', 5.5, 'flight'], ['', 1.25], ['←', 1, 'flight'], ['↓', 1, 'flight'], ['→', 1, 'flight']],
];

/** Condensed bindings for the start screen. */
export const START_KEYS: [string, string][] = [
  ['W / S', 'forward / back'],
  ['A / D', 'strafe'],
  ['Space / Ctrl or C', 'up / down'],
  ['Mouse · Q / E', 'steer · roll'],
  ['J · F', 'FTL drive · cruise'],
  ['T · G · click', 'target'],
  ['N · H', 'choose star · jump'],
  ['Shift · X', 'boost · stop'],
  ['O', 'orbit planner'],
  ['Z · V', 'flight assist · decouple'],
  ['P · K', 'sun-track · tanker'],
];
