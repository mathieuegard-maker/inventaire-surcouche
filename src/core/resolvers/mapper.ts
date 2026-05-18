// src/resolvers/mapper.ts
import type { RawBook } from '../types';

export const entityMapper = {
  /**
   * Transforme les données brutes d'Inventaire.io en objet RawBook structuré.
   * Fusionne systématiquement les données de l'édition et de l'œuvre (si fournie).
   */
  mapResponse(uri: string, raw: any, workRaw?: any): RawBook {
    console.log(`[MAPPER] Mapping pour ${uri} (Enrichissement œuvre : ${!!workRaw})`);
    
    const editionClaims = raw.claims || {};
    const workClaims = workRaw?.claims || {};

    // Helper pour extraire une valeur de claim (gère les formats string et objet)
    const getClaimValue = (claims: any, prop: string) => {
      const val = claims[prop]?.[0] || claims[`wdt:${prop}`]?.[0];
      if (!val) return undefined;
      // Correction : gère .value ou .url
      return typeof val === 'string' ? val : (val.value || val.url);
    };

    // 1. TITRE : Priorité à l'édition, repli sur l'œuvre ou le titre original
    const rawTitle = raw.label || raw.labels?.fr || raw.labels?.en;
    const workTitle = workRaw?.label || workRaw?.labels?.fr || workRaw?.labels?.en;
    const originalTitle = getClaimValue(workClaims, 'P1476') || getClaimValue(editionClaims, 'P1476');
    
    const title = rawTitle || workTitle || originalTitle || "Titre inconnu";

    // 2. WORK URI : On le récupère de l'édition (P629) ou on utilise l'URI si c'est déjà un work
    const workUri = getClaimValue(editionClaims, 'P629') || (raw.type === 'work' ? uri : undefined);

    // 3. SÉRIE ET NUMÉRO (P179 & P1545)
    let seriesId = getClaimValue(workClaims, 'P179') || getClaimValue(editionClaims, 'P179');
    let seriesNumber = getClaimValue(workClaims, 'P1545') || getClaimValue(editionClaims, 'P1545');

    // 4. IMAGE : Reconstruction dynamique selon ton format 300x300
    const rawImageSource = raw.image || 
                          (raw.images && raw.images[0]) || 
                          getClaimValue(editionClaims, 'P18') ||
                          workRaw?.image || 
                          (workRaw?.images && workRaw?.images[0]) || 
                          getClaimValue(workClaims, 'P18');

    // SONDE DEBUG : SOURCE IMAGE DÉTECTÉE
    console.log(`[DEBUG-MAPPER] Source brute d'image trouvée pour ${uri} :`, rawImageSource);

    let finalCoverUrl = undefined;
    
    if (rawImageSource) {
      // CORRECTION : On extrait le chemin (qu'il soit dans .url, .value ou direct)
      const imgPath = typeof rawImageSource === 'string' ? rawImageSource : (rawImageSource.url || rawImageSource.value);
      
      if (typeof imgPath === 'string') {
        // CORRECTION : On récupère uniquement le hash final (le dernier segment du chemin)
        const imgHash = imgPath.split('/').pop();
        
        if (imgHash) {
          // RECONSTRUCTION : Si c'est un hash, on utilise le format 300x300, sinon on garde l'URL absolue
          finalCoverUrl = imgHash.startsWith('http') 
            ? imgHash 
            : `https://inventaire.io/img/entities/300x300/${imgHash}`;
        }
      }
    }

    // SONDE DEBUG : URL FINALE
    console.log(`[DEBUG-MAPPER] URL reconstruite :`, finalCoverUrl);

    // 5. LISTES (Auteurs, Genres, etc.) : Fusion systématique
    const mergeIds = (prop: string, localProp?: string): string[] => {
      const extract = (data: any, p: string) => {
        const vals = data[p] || data[`wdt:${p}`] || [];
        return vals.map((v: any) => typeof v === 'string' ? v : (v.value || v.url)).filter(Boolean);
      };
      // On combine les IDs de l'édition (claims + root) et de l'œuvre
      const fromEdition = [...extract(editionClaims, prop), ...(localProp && raw[localProp] ? [raw[localProp]] : [])].flat();
      const fromWork = extract(workClaims, prop);
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
      pageCount: parseInt(getClaimValue(editionClaims, 'P1104')) || undefined,
      publishDate: getClaimValue(editionClaims, 'P577'),
      format: raw.format,

      // IDs pour les résolutions futures
      authorIds: mergeIds('P50', 'authors'),
      illustratorIds: mergeIds('P110'),
      scriptwriterIds: mergeIds('P58'),
      publisherId: getClaimValue(editionClaims, 'P123') || raw.publisher,
      
      seriesId: seriesId,
      seriesNumber: seriesNumber,
      
      genreIds: mergeIds('P136'),
      collectionId: getClaimValue(editionClaims, 'P195') || getClaimValue(workClaims, 'P195')
    };

    return mappedBook;
  }
};