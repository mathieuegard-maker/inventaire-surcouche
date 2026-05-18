// src/core/resolvers/humanizer.ts
//import { entityResolver } from './entity.resolver';
import type { RawBook, HumanizedBook } from '../types';

export const entityHumanizer = {
  async humanize(rawBook: RawBook): Promise<HumanizedBook> {
    console.log(`[HUMANIZER] Début pour ${rawBook.uri}`);

    // 1. COLLECTE : On ramasse tous les IDs obscurs (wdt:...) sans exception
    const allIds = new Set<string>();
    const addIds = (ids?: string | string[]) => {
      if (!ids) return;
      if (Array.isArray(ids)) ids.forEach(id => allIds.add(id));
      else allIds.add(ids);
    };

    addIds(rawBook.authorIds);
    addIds(rawBook.illustratorIds);
    addIds(rawBook.scriptwriterIds);
    addIds(rawBook.publisherId);
    addIds(rawBook.seriesId);
    addIds(rawBook.genreIds);
    addIds(rawBook.collectionId);

    const idArray = Array.from(allIds);
    const dictionary: Record<string, string> = {};

    // 2. MEGA-BATCHING : Une seule requête pour tout traduire d'un coup
    if (idArray.length > 0) {
      try {
        console.log(`[HUMANIZER] Traduction groupée de ${idArray.length} métadonnées...`);
        // Découpage en paquets de 50 pour respecter la limite d'Inventaire.io
        for (let i = 0; i < idArray.length; i += 50) {
          const chunk = idArray.slice(i, i + 50);
          
          // CORRECTION : Passage par le proxy Vercel pour centraliser le trafic et verrouiller les CORS
          const res = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
          const data = await res.json();
          const entities = data.entities || data;

          for (const [uri, entity] of Object.entries(entities)) {
            const e = entity as any;
            if (e.labels && e.labels.fr) dictionary[uri] = e.labels.fr;
            else if (e.labels && e.labels.en) dictionary[uri] = e.labels.en;
            else if (e.label) dictionary[uri] = e.label;
            else dictionary[uri] = uri;
          }
        }
      } catch (e) {
        console.warn("[HUMANIZER] Échec de traduction, utilisation des IDs bruts:", e);
      }
    }

    // Utilitaire pour piocher dans le dictionnaire
    const translateArray = (ids?: string[]) => (ids || []).map(id => dictionary[id]).filter(Boolean);
    const translateSingle = (id?: string) => id ? dictionary[id] : undefined;

    const targetImageUrl = rawBook.coverUrl || (rawBook as any).image;

    // 3. ASSEMBLAGE
    const humanized: HumanizedBook = {
      uri: rawBook.uri,
      workUri: rawBook.workUri,
      type: rawBook.type,
      title: rawBook.title,
      subtitle: rawBook.subtitle,
      originalTitle: rawBook.originalTitle,
      description: rawBook.description,
      isbn13: rawBook.isbn13,
      isbn10: rawBook.isbn10,
      coverUrl: targetImageUrl,
      localCover: undefined, // OPTIMISATION : L'image n'est plus traitée ici, l'UI est débloquée.
      pageCount: rawBook.pageCount,
      publishDate: rawBook.publishDate,
      format: rawBook.format,
      language: rawBook.language,

      authors: translateArray(rawBook.authorIds),
      illustrators: translateArray(rawBook.illustratorIds),
      scriptwriters: translateArray(rawBook.scriptwriterIds),
      publisher: translateSingle(rawBook.publisherId),
      series: translateSingle(rawBook.seriesId),
      seriesId: rawBook.seriesId,
      seriesNumber: rawBook.seriesNumber,
      genres: translateArray(rawBook.genreIds),
      collection: translateSingle(rawBook.collectionId),
      ownershipStatus: 'none'
    };

    console.log(`[HUMANIZER] Succès pour ${rawBook.uri} (Temps de blocage réduit à néant)`);
    return humanized;
  }
};