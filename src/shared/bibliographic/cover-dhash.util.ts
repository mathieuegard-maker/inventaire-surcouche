// src/shared/bibliographic/cover-dhash.util.ts
// Empreinte visuelle perceptuelle dHash 64 bits (pure, zéro dépendance) & élection par consensus visuel multi-éditions.

export const DHASH_WIDTH = 9;
export const DHASH_HEIGHT = 8;
export const DEFAULT_DHASH_THRESHOLD = 9; // <= 9 bits différents sur 64 (~86 % de similarité structurelle)

/**
 * Calcule une empreinte dHash 64-bit (16 caractères hex) à partir d'un buffer RGBA 9×8 pixels.
 * Normalise la luminance min-max pour tolérer les écarts de colorimétrie / exposition entre scans d'éditions.
 */
export function computeDHashFromRgba(
  rgba: Uint8Array | Uint8ClampedArray | number[],
  width = DHASH_WIDTH,
  height = DHASH_HEIGHT
): string {
  const count = width * height;
  const lum = new Float32Array(count);
  let minL = Infinity;
  let maxL = -Infinity;

  for (let i = 0; i < count; i++) {
    const idx = i * 4;
    const l = 0.299 * (rgba[idx] ?? 0) + 0.587 * (rgba[idx + 1] ?? 0) + 0.114 * (rgba[idx + 2] ?? 0);
    lum[i] = l;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }

  const span = maxL - minL > 1 ? maxL - minL : 1;
  let hex = '';
  let nibble = 0;
  let bitPos = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = (lum[y * width + x] - minL) / span;
      const right = (lum[y * width + x + 1] - minL) / span;
      const bit = left > right ? 1 : 0;
      nibble = (nibble << 1) | bit;
      bitPos++;
      if (bitPos === 4) {
        hex += nibble.toString(16);
        nibble = 0;
        bitPos = 0;
      }
    }
  }

  return hex;
}

/**
 * Distance de Hamming entre deux empreintes hexadécimales 64 bits (0 = identiques, 64 = opposées).
 */
export function hammingDistanceHex(hexA: string, hexB: string): number {
  if (!hexA || !hexB || hexA.length !== hexB.length) return 64;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

export interface FingerprintedCover {
  hash: string;
  area: number;
}

export interface CoverVisualCluster<T extends FingerprintedCover> {
  representative: T;
  count: number;
  members: T[];
}

/**
 * Regroupe des couvertures candidates par ressemblance visuelle (`dHash <= threshold`),
 * sélectionne la meilleure résolution dans chaque groupe, puis élit le groupe majoritaire (consensus multi-éditions).
 */
export function electConsensusCovers<T extends FingerprintedCover>(
  items: T[],
  threshold = DEFAULT_DHASH_THRESHOLD
): { winner: T | null; clusters: CoverVisualCluster<T>[] } {
  if (items.length === 0) {
    return { winner: null, clusters: [] };
  }

  const clusters: CoverVisualCluster<T>[] = [];
  for (const item of items) {
    const match = clusters.find((c) => hammingDistanceHex(c.representative.hash, item.hash) <= threshold);
    if (!match) {
      clusters.push({ representative: item, count: 1, members: [item] });
    } else {
      match.count++;
      match.members.push(item);
      // Conserver dans le groupe l'image nettement plus haute résolution
      if (item.area > match.representative.area * 1.15) {
        match.representative = item;
      }
    }
  }

  // Classement : 1) vote majoritaire (taille du groupe), 2) meilleure résolution du représentant
  clusters.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.representative.area - a.representative.area;
  });

  return {
    winner: clusters[0]?.representative ?? null,
    clusters
  };
}
