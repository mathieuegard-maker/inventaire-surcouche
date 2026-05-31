// src/core/utils/image.util.ts

import type { HumanizedBook } from '../types';

export const imageUtil = {
  /**
   * Résout l'URL finale de la couverture d'un livre.
   * Si l'image locale en Base64 existe, on l'utilise directement.
   * Si c'est une URL externe, on la fait passer par le Gateway (proxy d'image)
   * pour éviter les problèmes de CORS, Referrer-Policy, mixed-content, etc.
   */
  resolveCoverUrl(bookOrUrl: HumanizedBook | string | undefined | null): string {
    if (!bookOrUrl) return '';

    if (typeof bookOrUrl === 'object') {
      if (bookOrUrl.localCover) {
        return bookOrUrl.localCover;
      }
      return this.resolveExternalUrl(bookOrUrl.coverUrl);
    }

    return this.resolveExternalUrl(bookOrUrl);
  },

  /**
   * Fait passer une URL externe par le proxy d'image du Gateway.
   */
  resolveExternalUrl(url: string | undefined | null): string {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    return `/api/gateway?action=image-proxy&url=${encodeURIComponent(url)}`;
  }
};
