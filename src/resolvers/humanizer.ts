// src/resolvers/humanizer.ts
import type { RawBook, HumanizedBook } from './types';

export const entityHumanizer = {
  async humanize(rawBook: RawBook): Promise<HumanizedBook> {
    const idsToTranslate = new Set<string>();
    
    // Collecte des URIs
    rawBook.authorIds.forEach(id => idsToTranslate.add(id));
    rawBook.illustratorIds.forEach(id => idsToTranslate.add(id));
    rawBook.scriptwriterIds.forEach(id => idsToTranslate.add(id));
    rawBook.genreIds.forEach(id => idsToTranslate.add(id));
    if (rawBook.publisherId) idsToTranslate.add(rawBook.publisherId);
    if (rawBook.seriesId) idsToTranslate.add(rawBook.seriesId);
    if (rawBook.collectionId) idsToTranslate.add(rawBook.collectionId);

    let entities: any = {};
    if (idsToTranslate.size > 0) {
      // CORRECTION CRUCIALE : On utilise '|' et on encode l'URL
      const urisParam = encodeURIComponent(Array.from(idsToTranslate).join('|'));
      
      const res = await fetch(`/api/entities/by-uris?uris=${urisParam}`);
      const data = await res.json();
      
      // LOG POUR DEBUG : On vérifie que l'API renvoie bien les noms
      console.log("[DEBUG Humanizer] Dictionnaire de traduction API :", data);
      
      entities = data.entities || data;
    }

    const getName = (id?: string) => {
      if (!id || !entities[id]) return undefined;
      const entity = entities[id];
      // On cherche d'abord dans claims (parfois utilisé pour les redirections Wikidata), puis labels
      return entity.label || entity.labels?.fr || entity.labels?.en || id;
    };

    return {
      ...rawBook,
      authors: rawBook.authorIds.map(id => getName(id) || id),
      illustrators: rawBook.illustratorIds.map(id => getName(id) || id),
      scriptwriters: rawBook.scriptwriterIds.map(id => getName(id) || id),
      genres: rawBook.genreIds.map(id => getName(id) || id),
      publisher: getName(rawBook.publisherId),
      series: getName(rawBook.seriesId),
      collection: getName(rawBook.collectionId)
    };
  }
};