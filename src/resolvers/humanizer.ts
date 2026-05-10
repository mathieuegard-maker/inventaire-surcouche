// src/resolvers/humanizer.ts
import type { RawBook, HumanizedBook } from './types';

export const entityHumanizer = {
  async humanize(rawBook: RawBook): Promise<HumanizedBook> {
    const idsToTranslate = new Set<string>();
    
    rawBook.authorIds.forEach(id => idsToTranslate.add(id));
    rawBook.illustratorIds.forEach(id => idsToTranslate.add(id));
    rawBook.scriptwriterIds.forEach(id => idsToTranslate.add(id));
    rawBook.genreIds.forEach(id => idsToTranslate.add(id));
    if (rawBook.publisherId) idsToTranslate.add(rawBook.publisherId);
    if (rawBook.seriesId) idsToTranslate.add(rawBook.seriesId);
    if (rawBook.collectionId) idsToTranslate.add(rawBook.collectionId);

    let entities: any = {};
    if (idsToTranslate.size > 0) {
      const urisParam = encodeURIComponent(Array.from(idsToTranslate).join('|'));
      const res = await fetch(`/api/entities/by-uris?uris=${urisParam}`);
      const data = await res.json();
      entities = data.entities || data;
    }

    const getName = (id?: string) => {
      if (!id || !entities[id]) return undefined;
      const entity = entities[id];
      return entity.label || entity.labels?.fr || entity.labels?.en || id;
    };

    // 1. Traduction individuelle stricte
    const translatedAuthors = rawBook.authorIds.map(id => getName(id) || id);
    const translatedIllustrators = rawBook.illustratorIds.map(id => getName(id) || id);
    const translatedScriptwriters = rawBook.scriptwriterIds.map(id => getName(id) || id);

    // 2. RÈGLE MÉTIER BD (Fusion propre au sein de l'objet)
    let finalAuthors = translatedAuthors;
    if (finalAuthors.length === 0) {
      // S'il n'y a pas d'Auteur principal (P50), on fusionne les rôles techniques sans doublons
      finalAuthors = Array.from(new Set([...translatedScriptwriters, ...translatedIllustrators]));
    }

    return {
      ...rawBook,
      authors: finalAuthors, // Contient maintenant Denis Bajram !
      illustrators: translatedIllustrators,
      scriptwriters: translatedScriptwriters,
      genres: rawBook.genreIds.map(id => getName(id) || id),
      publisher: getName(rawBook.publisherId),
      series: getName(rawBook.seriesId),
      collection: getName(rawBook.collectionId)
    };
  }
};