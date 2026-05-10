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
        // C'est un objet : on récupère la valeur texte ET le numéro de tome dans les qualificateurs
        extractedSeriesId = seriesClaim.value;
        extractedSeriesNumber = seriesClaim.qualifiers?.['wdt:P1545']?.[0];
      }
    }
    
    // Fallback au cas où le numéro de série serait à la racine (rare mais possible)
    extractedSeriesNumber = extractedSeriesNumber || (claims['wdt:P1545'] && claims['wdt:P1545'][0]);

    const mappedBook: RawBook = {
      uri: uri,
      workUri: workUri, // On l'injecte ici
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
      
      // Les données corrigées
      seriesId: extractedSeriesId,
      seriesNumber: extractedSeriesNumber,
      
      genreIds: claims['wdt:P136'] || [],
      collectionId: (claims['wdt:P195'] && claims['wdt:P195'][0])
    };

    console.log(`[MAPPER] Sortie RawBook structurée (seriesId: ${mappedBook.seriesId}):`, mappedBook);
    return mappedBook;
  }
};