import { describe, expect, it } from 'vitest';
import { cityHash } from '../sim/airspace';

// The values city.wgsl's cityHash gave on a GPU (Dawn, WebGPU) for these inputs and seed: the CPU's
// port has to match it exactly, or the closed airspace isn't where the cities are drawn.
const SEED = 37.68482506275177;
const GPU: [number[], number[]][] = [
  [[0, 0, 0, 0], [0.48749, 0.00985, 0.9182]],
  [[5, -3, 17, 31], [0.61482, 0.54454, 0.48373]],
  [[-120, 44, 33, 0], [0.20499, 0.71092, 0.31944]],
  [[960, -960, 81, 31], [0.5955, 0.13376, 0.65191]],
  [[12, 7, 100, 0], [0.5253, 0.10794, 0.91071]],
];

describe('airspace', () => {
  it("hashes city cells as the shader does", () => {
    for (const [[x, y, z, salt], want] of GPU) {
      const h = cityHash(x, y, z, salt, SEED);
      for (let i = 0; i < 3; i++) expect(h[i]).toBeCloseTo(want[i], 4);
    }
  });
});
