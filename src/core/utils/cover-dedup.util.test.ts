import { describe, it, expect } from 'vitest';
import { computeDHashFromRgba, hammingDistanceHex } from './cover-dedup.util';

function makeGradientRgba(scale = 1, offset = 0, invert = false): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(9 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const idx = (y * 9 + x) * 4;
      const base = invert ? (8 - x) * 24 + y * 5 : x * 24 + y * 5;
      const v = Math.max(0, Math.min(255, Math.round(base * scale + offset)));
      arr[idx] = v;
      arr[idx + 1] = Math.max(0, Math.min(255, v - 10));
      arr[idx + 2] = Math.max(0, Math.min(255, v + 8));
      arr[idx + 3] = 255;
    }
  }
  return arr;
}

describe('cover-dedup.util', () => {
  it('produit une empreinte identique malgré des variations de colorimétrie / luminosité', () => {
    const hashRef = computeDHashFromRgba(makeGradientRgba(1, 0));
    const hashBright = computeDHashFromRgba(makeGradientRgba(0.85, 35));

    expect(hashRef).toHaveLength(16);
    expect(hammingDistanceHex(hashRef, hashBright)).toBeLessThanOrEqual(4);
  });

  it('distingue nettement deux visuels structurellement différents', () => {
    const hashLeft = computeDHashFromRgba(makeGradientRgba(1, 0, false));
    const hashRight = computeDHashFromRgba(makeGradientRgba(1, 0, true));

    expect(hammingDistanceHex(hashLeft, hashRight)).toBeGreaterThan(30);
  });
});
