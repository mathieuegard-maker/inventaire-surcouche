// src/resolvers/mapper.ts
import type { RawBook } from './types';

export const entityMapper = {
  /**
   * Transforme les données brutes d'Inventaire.io en objet RawBook structuré.
   * Fusionne systématiquement les données de l'édition et de l'œuvre (si fournie).
   */
  mapResponse(uri: string, raw: any, workRaw?: any): RawBook {
    console.log(`[MAPPER] Mapping pour ${uri} (Enrichissement œuvre : ${!!workRaw})`);
    
    const editionClaims = raw.claims || {};
    const workClaims = workRaw?.claims || {};

    // 1. TITRE : Priorité à l'édition, repli sur l'œuvre ou le titre original
    const rawTitle = raw.label || raw.labels?.fr || raw.labels?.en;
    const workTitle = workRaw?.label || workRaw?.labels?.fr || workRaw?.labels?.en;
    const originalTitle = workClaims['wdt:P1476']?.[0] || editionClaims['wdt:P1476']?.[0];
    
    const title = rawTitle || workTitle || originalTitle || "Titre inconnu";

    // 2. WORK URI : On le récupère de l'édition (P629) ou on utilise l'URI si c'est déjà un work
    const workUri = editionClaims['wdt:P629']?.[0] || (raw.type === 'work' ? uri : undefined);

    // 3. SÉRIE ET NUMÉRO (P179 & P1545) : On cherche sur l'édition, puis sur l'œuvre
    let seriesId;
    let seriesNumber;

    // On vérifie d'abord l'œuvre (source de vérité pour la série), puis l'édition
    const seriesClaim = workClaims['wdt:P179']?.[0] || editionClaims['wdt:P179']?.[0];

    if (seriesClaim) {
      if (typeof seriesClaim === 'string') {
        seriesId = seriesClaim;
      } else {
        seriesId = seriesClaim.value;
        seriesNumber = seriesClaim.qualifiers?.['wdt:P1545']?.[0];
      }
    }
    
    seriesNumber = seriesNumber || workClaims['wdt:P1545']?.[0] || editionClaims['wdt:P1545']?.[0];

    // 4. IMAGE : Gestion robuste (Édition > Œuvre)
    const rawImageUrl = raw.image || (raw.images && raw.images[0]) || editionClaims['wdt:P18']?.[0] || workClaims['wdt:P18']?.[0];
    let finalCoverUrl = undefined;
    
    const imageUrlStr = typeof rawImageUrl === 'string' ? rawImageUrl : (rawImageUrl?.value || undefined);
    
    if (typeof imageUrlStr === 'string') {
      finalCoverUrl = imageUrlStr.startsWith('http') 
        ? imageUrlStr 
        : `https://inventaire.io/img/entities/${encodeURIComponent(imageUrlStr)}`;
    }

    // 5. LISTES (Auteurs, Genres, etc.) : Fusion systématique pour ne rien rater
    const mergeIds = (prop: string, localProp?: string): string[] => {
      const fromEdition = editionClaims[prop] || (localProp ? raw[localProp] : []) || [];
      const fromWork = workClaims[prop] || [];
      return Array.from(new Set([...fromEdition, ...fromWork]));
    };

    const mappedBook: RawBook = {
      uri: uri,
      workUri: workUri,
      isbn13: raw.isbn13 || (uri.startsWith('isbn:') ? uri.split(':')[1] : undefined),
      isbn10: raw.isbn10,
      type: (raw.type as any) || 'unknown',
      title: title,
      subtitle: raw.subtitle || workRaw?.subtitle,
      originalTitle: originalTitle,
      description: raw.description || raw.descriptions?.fr || workRaw?.description || workRaw?.descriptions?.fr,
      coverUrl: finalCoverUrl,
      language: raw.language || workRaw?.language,
      pageCount: editionClaims['wdt:P1104'] ? parseInt(editionClaims['wdt:P1104'][0]) : undefined,
      publishDate: editionClaims['wdt:P577'] ? editionClaims['wdt:P577'][0] : undefined,
      format: raw.format,

      // IDs pour les résolutions futures
      authorIds: mergeIds('wdt:P50', 'authors'),
      illustratorIds: mergeIds('wdt:P110'),
      scriptwriterIds: mergeIds('wdt:P58'),
      publisherId: editionClaims['wdt:P123']?.[0] || raw.publisher,
      
      seriesId: seriesId,
      seriesNumber: seriesNumber,
      
      genreIds: mergeIds('wdt:P136'),
      collectionId: editionClaims['wdt:P195']?.[0] || workClaims['wdt:P195']?.[0]
    };

    return mappedBook;
  }
};