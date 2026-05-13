// src/resolvers/mapper.ts
import type { RawBook } from './types';

export const entityMapper = {
  mapResponse(uri: string, raw: any): RawBook {
    console.log(`[MAPPER] Entrée brute pour ${uri}:`, raw);
    const claims = raw.claims || {};
    
    // FALLBACK TITRE : Si label est vide, on prend originalTitle (P1476)
    const rawTitle = raw.label || raw.labels?.fr || raw.labels?.en;
    const originalTitle = (claims['wdt:P1476'] && claims['wdt:P1476'][0]);
    const title = rawTitle || originalTitle || "Titre inconnu";
    const workUri = claims['wdt:P629'] ? claims['wdt:P629'][0] : (raw.type === 'work' ? uri : undefined);

    // EXTRACTION INTELLIGENTE DE LA SÉRIE (P179) ET DU NUMÉRO DE TOME (P1545)
    let extractedSeriesId;
    let extractedSeriesNumber;
    const seriesClaim = claims['wdt:P179']?.[0];

    if (seriesClaim) {
      if (typeof seriesClaim === 'string') {
        extractedSeriesId = seriesClaim;
      } else {
        extractedSeriesId = seriesClaim.value;
        extractedSeriesNumber = seriesClaim.qualifiers?.['wdt:P1545']?.[0];
      }
    }
    
    extractedSeriesNumber = extractedSeriesNumber || (claims['wdt:P1545'] && claims['wdt:P1545'][0]);

    // GESTION ROBUSTE DE L'IMAGE -> coverUrl
    const rawImageUrl = raw.image || (raw.images && raw.images[0]) || (claims['wdt:P18'] && claims['wdt:P18'][0]);
    let finalCoverUrl = undefined;
    
    // CORRECTION DU CRASH: On s'assure que l'on manipule bien une chaîne de caractères
    const imageUrlStr = typeof rawImageUrl === 'string' ? rawImageUrl : (rawImageUrl?.value || undefined);
    
    if (typeof imageUrlStr === 'string') {
      finalCoverUrl = imageUrlStr.startsWith('http') 
        ? imageUrlStr 
        : `https://inventaire.io/img/entities/${encodeURIComponent(imageUrlStr)}`;
    }

    const mappedBook: RawBook = {
      uri: uri,
      workUri: workUri,
      isbn13: raw.isbn13 || (uri.startsWith('isbn:') ? uri.split(':')[1] : undefined),
      isbn10: raw.isbn10,
      type: (raw.type as any) || 'unknown',
      title: title,
      subtitle: raw.subtitle,
      originalTitle: originalTitle,
      description: raw.description || raw.descriptions?.fr,
      coverUrl: finalCoverUrl,
      language: raw.language,
      pageCount: claims['wdt:P1104'] ? parseInt(claims['wdt:P1104'][0]) : undefined,
      publishDate: claims['wdt:P577'] ? claims['wdt:P577'][0] : undefined,
      format: raw.format,

      authorIds: claims['wdt:P50'] || raw.authors || [],
      illustratorIds: claims['wdt:P110'] || [],
      scriptwriterIds: claims['wdt:P58'] || [],
      publisherId: (claims['wdt:P123'] && claims['wdt:P123'][0]) || raw.publisher,
      
      seriesId: extractedSeriesId,
      seriesNumber: extractedSeriesNumber,
      
      genreIds: claims['wdt:P136'] || [],
      collectionId: (claims['wdt:P195'] && claims['wdt:P195'][0])
    };

    console.log(`[MAPPER] Sortie RawBook structurée (seriesId: ${mappedBook.seriesId}):`, mappedBook);
    return mappedBook;
  }
};