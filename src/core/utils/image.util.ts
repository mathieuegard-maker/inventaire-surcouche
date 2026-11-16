// src/core/utils/image.util.ts

import type { HumanizedBook } from '../types';
import { isbnUtil } from './isbn.util';

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
    if (url.startsWith('data:') || url.startsWith('/api/gateway?')) return url;
    const normalized = url.replace(/^http:\/\//i, 'https://');
    return `/api/gateway?action=image-proxy&url=${encodeURIComponent(normalized)}`;
  },

  /**
   * Construit une liste ordonnée et dédupliquée d'URLs de couverture candidates
   * (sources explicites puis repli CDN par ISBN-10 / ISBN-13) pour éviter les images cassées.
   */
  buildCoverCandidates(isbn13?: string, preferredUrls: Array<string | undefined | null> = []): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (raw?: string | null) => {
      const clean = raw?.trim();
      if (!clean) return;
      const normalized = clean.startsWith('data:') ? clean : clean.replace(/^http:\/\//i, 'https://');
      if (seen.has(normalized)) return;
      seen.add(normalized);
      out.push(normalized);
    };

    for (const url of preferredUrls) {
      add(url);
    }

    const cleanIsbn13 = isbn13 ? isbnUtil.normalize(isbn13) : '';
    if (cleanIsbn13.length === 13) {
      const isbn10 = isbnUtil.toIsbn10(cleanIsbn13);
      if (isbn10) {
        add(`https://images-eu.ssl-images-amazon.com/images/P/${isbn10}.08.LZZZZZZZ.jpg`);
        add(`https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_SX500_.jpg`);
      }
      add(`https://servimg.eyrolles.com/static/media/${cleanIsbn13.slice(-4)}/${cleanIsbn13}_internet_h1400.jpg`);
      add(`https://covers.openlibrary.org/b/isbn/${cleanIsbn13}-L.jpg?default=false`);
    }

    return out;
  },

  /**
   * Passe automatiquement à l'URL de repli suivante lorsqu'une image de couverture échoue au chargement (404 / placeholder rejeté),
   * ou efface `coverUrl` si toutes les pistes ont échoué pour afficher le visuel de remplacement.
   */
  advanceCoverFallback(target: { coverUrl?: string; coverFallbackUrls?: string[] }): void {
    const current = target.coverUrl?.trim();
    const fallbacks = (target.coverFallbackUrls || []).filter((u) => u && u !== current);
    target.coverFallbackUrls = fallbacks;
    target.coverUrl = fallbacks.length > 0 ? fallbacks[0] : undefined;
  },

  /**
   * Extrait l'URL distante originale depuis une URL éventuellement proxifiée via `/api/gateway?action=image-proxy`.
   */
  extractRawUrl(src: string | undefined | null): string {
    const trimmed = (src || '').trim();
    if (!trimmed) return '';
    const match = /[?&]action=image-proxy&url=([^&]+)/.exec(trimmed);
    if (match?.[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  },

  /**
   * Gestionnaire `@error` générique pour les balises `<img>` de couverture :
   * parcourt les URLs candidates construites depuis l'ISBN et bascule vers l'URL suivante,
   * puis déclenche `onExhausted()` lorsque toutes les sources ont échoué.
   */
  handleImageError(
    eventOrEl: Event | HTMLImageElement | null | undefined,
    options: { isbn?: string; fallbackUrls?: string[]; onExhausted?: () => void } = {}
  ): boolean {
    const imgEl =
      eventOrEl && 'currentTarget' in eventOrEl
        ? ((eventOrEl.currentTarget || eventOrEl.target) as HTMLImageElement | null)
        : (eventOrEl as HTMLImageElement | null);
    if (!imgEl || typeof imgEl !== 'object') {
      options.onExhausted?.();
      return false;
    }

    const currentRaw = this.extractRawUrl(imgEl.getAttribute('src') || imgEl.src);
    if (!imgEl.dataset.coverOrigUrl && currentRaw && !currentRaw.startsWith('data:')) {
      imgEl.dataset.coverOrigUrl = currentRaw;
    }

    const initialRaw = imgEl.dataset.coverOrigUrl || '';
    const candidates = this.buildCoverCandidates(options.isbn, [
      ...(initialRaw ? [initialRaw] : []),
      ...(options.fallbackUrls || [])
    ]);

    const triedRaw = (imgEl.dataset.coverTried || '').split('|').filter(Boolean);
    const tried = new Set<string>(triedRaw);
    if (currentRaw) tried.add(currentRaw);

    const nextCandidate = candidates.find((c) => !tried.has(c));
    if (nextCandidate) {
      tried.add(nextCandidate);
      imgEl.dataset.coverTried = Array.from(tried).join('|');
      imgEl.src = this.resolveExternalUrl(nextCandidate);
      return true;
    }

    options.onExhausted?.();
    return false;
  }
};
