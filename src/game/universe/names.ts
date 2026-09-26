import type { Rng } from '../lib/rng';

const S1 = ['Ar', 'Bel', 'Cor', 'Dra', 'El', 'Fen', 'Gal', 'Hy', 'Ix', 'Jor', 'Ka', 'Lu', 'Mer', 'Nox', 'Or', 'Pra', 'Qua', 'Ros', 'Syl', 'Tau', 'Ul', 'Vex', 'Wy', 'Xan', 'Yor', 'Zel', 'Cet', 'Hel', 'Ny', 'Ara', 'Kep', 'Sol', 'Mira', 'Ven', 'Tor'];
const S2 = ['a', 'e', 'i', 'o', 'u', 'ae', 'io', 'ar', 'en', 'or', 'is', 'un', 'y', 'ea'];
const S3 = ['n', 's', 'th', 'x', 'ris', 'lon', 'tis', 'dor', 'ra', 'nus', 'ka', 'mir', 'vel', 'phi', 'go', 'des', ''];
const CATALOGUES = ['HIP', 'HD', 'Gliese', 'LHS', 'Wolf', 'Ross'];

/** A unique star name: mostly syllable soup, sometimes a catalogue number. */
export function makeName(g: Rng, used: Set<string>) {
  for (let k = 0; k < 20; k++) {
    let n: string;
    const r = g();
    if (r < 0.12) n = CATALOGUES[Math.floor(g() * 6)] + ' ' + (100 + Math.floor(g() * 9800));
    else n = S1[Math.floor(g() * S1.length)] + S2[Math.floor(g() * S2.length)] + S3[Math.floor(g() * S3.length)];
    if (!used.has(n)) {
      used.add(n);
      return n;
    }
  }
  return 'Unnamed ' + Math.floor(g() * 1e5);
}

/**
 * A name for a procedurally generated star. Names aren't checked for uniqueness (the galaxy is
 * generated lazily, so there's no global list), so the name space is kept large instead: mostly
 * two-part syllable names (about 4 million), some short ones, and catalogue numbers.
 */
export function starName(g: Rng) {
  const r = g();
  const pick = (a: string[]) => a[Math.floor(g() * a.length)];
  if (r < 0.1) return pick(CATALOGUES) + ' ' + (100 + Math.floor(g() * 99900));
  if (r < 0.35) return pick(S1) + pick(S2) + pick(S3);
  return pick(S1) + pick(S2) + pick(S1).toLowerCase() + pick(S2) + pick(S3);
}
