// src/core/resolvers/humanizer.ts
import type { RawBook, HumanizedBook } from '../types';
import { databaseService } from '../database/database.service';

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

    // Extraction dynamique de la langue du navigateur pour l'alignement international des filtres
    const browserLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language.split('-')[0].toLowerCase() : 'fr';

    // 2. MEGA-BATCHING : Une seule requête pour tout traduire d'un coup
    if (idArray.length > 0) {
      try {
        console.log(`[HUMANIZER] Traduction groupée de ${idArray.length} métadonnées...`);
        for (let i = 0; i < idArray.length; i += 50) {
          const chunk = idArray.slice(i, i + 50);
          
          const res = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
          const data = await res.json();
          const entities = data.entities || data;

          for (const [uri, entity] of Object.entries(entities)) {
            const e = entity as any;
            // Élection de la langue adaptative avec replis sécurisés
            if (e.labels && e.labels[browserLang]) dictionary[uri] = e.labels[browserLang];
            else if (e.labels && e.labels.fr) dictionary[uri] = e.labels.fr;
            else if (e.labels && e.labels.en) dictionary[uri] = e.labels.en;
            else if (e.label) dictionary[uri] = e.label;
            else dictionary[uri] = uri;
          }
        }
      } catch (e) {
        console.warn("[HUMANIZER] Échec de traduction, utilisation des IDs bruts:", e);
      }
    }

    const translateArray = (ids?: string[]) => (ids || []).map(id => dictionary[id] || id).filter(Boolean);
    const translateSingle = (id?: string) => id ? (dictionary[id] || id) : undefined;

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
      localCover: undefined,
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

    console.log(`[HUMANIZER] Succès pour ${rawBook.uri} (Alignement multilingue actif)`);
    return humanized;
  },

  /**
   * Ré-humanise à la volée un livre déjà en cache qui contient des IDs Wikidata bruts (wd:...)
   */
  async rehumanize(book: HumanizedBook): Promise<HumanizedBook | null> {
    console.log(`[REHUMANIZER] Détection de ré-humanisation pour ${book.uri}`);
    const allIds = new Set<string>();
    
    const checkAndAdd = (val: string | undefined) => {
      if (val && val.startsWith('wd:')) {
        allIds.add(val);
      }
    };
    
    const checkAndAddArray = (arr: string[] | undefined) => {
      if (arr) {
        arr.forEach(val => {
          if (val && val.startsWith('wd:')) {
            allIds.add(val);
          }
        });
      }
    };

    checkAndAddArray(book.authors);
    checkAndAddArray(book.illustrators);
    checkAndAddArray(book.scriptwriters);
    checkAndAdd(book.publisher);
    checkAndAdd(book.series);
    checkAndAddArray(book.genres);
    checkAndAdd(book.collection);

    const idArray = Array.from(allIds);
    if (idArray.length === 0) return null;

    try {
      console.log(`[REHUMANIZER] Résolution à la volée de ${idArray.length} identifiants bruts...`);
      const browserLang = typeof navigator !== 'undefined' && navigator.language ? navigator.language.split('-')[0].toLowerCase() : 'fr';
      const dictionary: Record<string, string> = {};

      for (let i = 0; i < idArray.length; i += 50) {
        const chunk = idArray.slice(i, i + 50);
        const res = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
        const data = await res.json();
        const entities = data.entities || data;

        for (const [uri, entity] of Object.entries(entities)) {
          const e = entity as any;
          if (e.labels && e.labels[browserLang]) dictionary[uri] = e.labels[browserLang];
          else if (e.labels && e.labels.fr) dictionary[uri] = e.labels.fr;
          else if (e.labels && e.labels.en) dictionary[uri] = e.labels.en;
          else if (e.label) dictionary[uri] = e.label;
        }
      }

      const translate = (val: string | undefined) => val && dictionary[val] ? dictionary[val] : val;
      const translateArray = (arr: string[] | undefined) => arr ? arr.map(val => dictionary[val] || val) : [];

      book.authors = translateArray(book.authors);
      book.illustrators = translateArray(book.illustrators);
      book.scriptwriters = translateArray(book.scriptwriters);
      book.publisher = translate(book.publisher);
      book.series = translate(book.series);
      book.genres = translateArray(book.genres);
      book.collection = translate(book.collection);

      await databaseService.saveBookToCache(book);
      console.log(`[REHUMANIZER] Ré-humanisation réussie pour ${book.uri}`);
      return book;
    } catch (e) {
      console.warn("[REHUMANIZER] Erreur lors de la ré-humanisation :", e);
      return null;
    }
  }
};