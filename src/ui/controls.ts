/** Key bindings shown in the in-flight controls list. */
export const HELP_KEYS: [string, string][] = [
  ['W / S', 'Thrust fwd / back · FTL throttle'],
  ['A / D', 'Strafe left / right'],
  ['Space / Ctrl, C', 'Thrust up / down'],
  ['Mouse, arrows', 'Pitch and yaw'],
  ['Q / E', 'Roll'],
  ['Shift', 'Boost'],
  ['X', 'All stop'],
  ['J', 'FTL drive on / off'],
  ['F', 'FTL cruise control (else hold W)'],
  ['T / G · click', 'Target ahead / next nearest / clicked'],
  ['N / H', 'Pick star (aim or cycle) / hyperjump'],
  ['O', 'Orbit planner · autopilot off'],
  ['Z', 'Flight assist on / off'],
  ['V', 'Decoupled: turn without changing course'],
  ['P', 'Point solar panels at the star'],
  ['K', 'Call a fuel tanker'],
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
