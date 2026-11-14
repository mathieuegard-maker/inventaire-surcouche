// src/core/utils/webp-compressor.util.ts
// Compression d'images côté client en WebP léger (~30-50 Ko) pour économiser le stockage et la bande passante.

export interface CompressOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  cropRatio?: number; // ex: 0.7 pour un ratio couverture de livre (largeur / hauteur)
}

export async function compressImageToWebpDataUrl(
  source: Blob | File | string,
  options: CompressOptions = {}
): Promise<string> {
  const maxWidth = options.maxWidth ?? 480;
  const maxHeight = options.maxHeight ?? 680;
  const quality = options.quality ?? 0.78;

  const img = await loadImageElement(source);

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth || img.width;
  let sh = img.naturalHeight || img.height;

  // Si un ratio de recadrage couverture central est demandé (ex: photo prise au téléphone)
  if (options.cropRatio && sw > 0 && sh > 0) {
    const currentRatio = sw / sh;
    if (currentRatio > options.cropRatio) {
      const targetW = Math.round(sh * options.cropRatio);
      sx = Math.round((sw - targetW) / 2);
      sw = targetW;
    } else if (currentRatio < options.cropRatio) {
      const targetH = Math.round(sw / options.cropRatio);
      sy = Math.round((sh - targetH) / 2);
      sh = targetH;
    }
  }

  const scale = Math.min(1, maxWidth / sw, maxHeight / sh);
  const targetWidth = Math.max(1, Math.round(sw * scale));
  const targetHeight = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Contexte Canvas 2D indisponible');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  // Essaie WebP en priorité, repli automatique sur JPEG si le navigateur ne supporte pas l'encodage WebP
  const webpUrl = canvas.toDataURL('image/webp', quality);
  if (webpUrl.startsWith('data:image/webp')) {
    return webpUrl;
  }
  return canvas.toDataURL('image/jpeg', quality);
}

function loadImageElement(source: Blob | File | string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let objectUrl: string | null = null;

    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(img);
    };
    img.onerror = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      reject(new Error("Impossible de charger l'image pour la compression"));
    };

    if (typeof source === 'string') {
      img.src = source;
    } else {
      objectUrl = URL.createObjectURL(source);
      img.src = objectUrl;
    }
  });
}
