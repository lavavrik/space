export type Rng = () => number;

/** Small, fast seeded PRNG. Every system is generated from fixed seeds, so it's the same on every visit. */
export function mulberry32(a: number): Rng {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [a, b). */
export const rr = (g: Rng, a: number, b: number) => a + (b - a) * g();
/** Log-uniform in [a, b). */
export const lr = (g: Rng, a: number, b: number) => Math.exp(rr(g, Math.log(a), Math.log(b)));
