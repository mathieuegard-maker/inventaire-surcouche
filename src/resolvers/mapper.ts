// src/resolvers/mapper.ts
import type { RawBook } from './types';

export const entityMapper = {
  mapResponse(uri: string, raw: any): RawBook {
    const claims = raw.claims || {};
    
    // FALLBACK TITRE : Si label est vide, on prend originalTitle (P1476)
    const rawTitle = raw.label || raw.labels?.fr || raw.labels?.en;
    const originalTitle = (claims['wdt:P1476'] && claims['wdt:P1476'][0]);
    const title = rawTitle || originalTitle || "Titre inconnu";

    return {
      uri: uri,
      isbn13: raw.isbn13 || (uri.startsWith('isbn:') ? uri.split(':')[1] : undefined),
      isbn10: raw.isbn10,
      type: (raw.type as any) || 'unknown',
      title: title,
      subtitle: raw.subtitle,
      originalTitle: originalTitle,
      description: raw.description || raw.descriptions?.fr,
      image: raw.image || (raw.images && raw.images[0]),
      language: raw.language,
      pageCount: claims['wdt:P1104'] ? parseInt(claims['wdt:P1104'][0]) : undefined,
      publishDate: claims['wdt:P577'] ? claims['wdt:P577'][0] : undefined,
      format: raw.format,

      // IDs (on garde ce qu'on trouve)
      authorIds: claims['wdt:P50'] || raw.authors || [],
      illustratorIds: claims['wdt:P110'] || [],
      scriptwriterIds: claims['wdt:P58'] || [],
      publisherId: (claims['wdt:P123'] && claims['wdt:P123'][0]) || raw.publisher,
      seriesId: (claims['wdt:P179'] && claims['wdt:P179'][0]),
      seriesNumber: (claims['wdt:P1545'] && claims['wdt:P1545'][0]),
      genreIds: claims['wdt:P136'] || [],
      collectionId: (claims['wdt:P195'] && claims['wdt:P195'][0])
    };
  }
};