// src/core/utils/cover-dedup.util.ts
// Déduplication visuelle de couvertures par empreinte perceptuelle dHash (64 bits)
// Insensible aux changements de résolution, compression JPEG/WebP et légers écarts de colorimétrie/luminosité.

import { imageUtil } from './image.util';

const DHASH_WIDTH = 9;
const DHASH_HEIGHT = 8;
const DEFAULT_HAMMING_THRESHOLD = 9; // <= 9 bits différents sur 64 (~86% de similarité structurelle)

/**
 * Calcule une empreinte dHash 64-bit (16 caractères hex) à partir d'un tableau RGBA (9x8 pixels).
 * Inclut une normalisation min-max de luminance pour tolérer les écarts de colorimétrie / exposition.
 */
export function computeDHashFromRgba(rgba: Uint8ClampedArray | number[], width = DHASH_WIDTH, height = DHASH_HEIGHT): string {
  const count = width * height;
  const lum = new Float32Array(count);
  let minL = Infinity;
  let maxL = -Infinity;

  for (let i = 0; i < count; i++) {
    const idx = i * 4;
    const l = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
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

export function hammingDistanceHex(hexA: string, hexB: string): number {
  if (hexA.length !== hexB.length) return 64;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    // popcount sur 4 bits
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

async function computeImageFingerprint(
  url: string,
  isbn?: string,
  timeoutMs = 5000
): Promise<{ url: string; hash: string; area: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    return null;
  }

  const proxied = imageUtil.resolveExternalUrl(url, isbn);
  if (!proxied) return null;

  return await new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => {
      img.src = '';
      resolve(null);
    }, timeoutMs);

    img.onload = () => {
      clearTimeout(timer);
      const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
      if (area < 2500) {
        resolve(null);
        return;
      }
      try {
        const canvas = document.createElement('canvas');
        canvas.width = DHASH_WIDTH;
        canvas.height = DHASH_HEIGHT;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0, DHASH_WIDTH, DHASH_HEIGHT);
        const data = ctx.getImageData(0, 0, DHASH_WIDTH, DHASH_HEIGHT).data;
        const hash = computeDHashFromRgba(data);
        resolve({ url, hash, area });
      } catch {
        resolve(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };

    img.src = proxied;
  });
}

/**
 * Filtre et déduplique visuellement une liste d'URLs de couvertures :
 * - élimine les URLs cassées / placeholders
 * - regroupe les images visuellement identiques (distance dHash <= seuil)
 * - conserve la meilleure résolution pour chaque couverture distincte.
 */
export async function deduplicateCoverUrls(
  urls: string[],
  options: { isbn?: string; threshold?: number; maxCandidates?: number } = {}
): Promise<string[]> {
  const uniqueUrls = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean))).slice(
    0,
    options.maxCandidates ?? 20
  );
  if (uniqueUrls.length <= 1 || typeof document === 'undefined') {
    return uniqueUrls;
  }

  const threshold = options.threshold ?? DEFAULT_HAMMING_THRESHOLD;
  const fingerprints = await Promise.all(
    uniqueUrls.map((u) => computeImageFingerprint(u, options.isbn))
  );

  const kept: Array<{ url: string; hash: string; area: number }> = [];
  for (const fp of fingerprints) {
    if (!fp) continue;
    const matchIdx = kept.findIndex((k) => hammingDistanceHex(k.hash, fp.hash) <= threshold);
    if (matchIdx === -1) {
      kept.push(fp);
    } else if (fp.area > kept[matchIdx].area * 1.2) {
      // Remplacer par une version nettement plus haute résolution de la même couverture
      kept[matchIdx] = fp;
    }
  }

  // Si aucune image n'a pu être analysée (ex. hors-ligne), retourner les URLs uniques brutes
  return kept.length > 0 ? kept.map((k) => k.url) : uniqueUrls;
}
