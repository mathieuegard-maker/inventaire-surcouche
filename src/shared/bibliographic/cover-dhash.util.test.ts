// src/shared/bibliographic/cover-dhash.util.test.ts
// Tests unitaires de l'empreinte perceptuelle dHash 64-bit et de l'élection par consensus visuel multi-éditions.

import { describe, expect, it } from 'vitest';
import { computeDHashFromRgba, electConsensusCovers, hammingDistanceHex } from './cover-dhash.util';

function makeGradientRgba(invert = false, brightnessShift = 0): Uint8Array {
  const out = new Uint8Array(9 * 8 * 4);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const idx = (y * 9 + x) * 4;
      const base = invert ? 255 - (x * 24 + y * 5) : x * 24 + y * 5;
      const v = Math.max(0, Math.min(255, base + brightnessShift));
      out[idx] = v;
      out[idx + 1] = v;
      out[idx + 2] = v;
      out[idx + 3] = 255;
    }
  }
  return out;
}

describe('cover-dhash.util — Empreinte perceptuelle & consensus visuel multi-éditions', () => {
  it('produit une empreinte identique malgré un décalage de luminosité et une distance maximale sur une image inversée', () => {
    const h1 = computeDHashFromRgba(makeGradientRgba(false, 0));
    const h2 = computeDHashFromRgba(makeGradientRgba(false, 25));
    const hInv = computeDHashFromRgba(makeGradientRgba(true, 0));

    expect(h1).toHaveLength(16);
    expect(hammingDistanceHex(h1, h2)).toBe(0);
    expect(hammingDistanceHex(h1, hInv)).toBe(64);
  });

  it('élit le groupe majoritaire (consensus entre 3 éditions vs 1 outlier haute résolution) et choisit la plus haute résolution du groupe gagnant', () => {
    const hMain = computeDHashFromRgba(makeGradientRgba(false, 0));
    const hOutlier = computeDHashFromRgba(makeGradientRgba(true, 0));

    const { winner, clusters } = electConsensusCovers([
      { id: 'outlier_hd', hash: hOutlier, area: 800 * 1200 },
      { id: 'ed1_small', hash: hMain, area: 200 * 300 },
      { id: 'ed2_hd', hash: hMain, area: 420 * 640 },
      { id: 'ed3_med', hash: hMain, area: 300 * 450 }
    ]);

    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(3);
    expect(clusters[1].count).toBe(1);
    // Le consensus majoritaire (3 éditions) bat l'outlier isolé même plus grand, et retient la version la plus nette du cluster !
    expect(winner?.id).toBe('ed2_hd');
  });
});
