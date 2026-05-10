// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from './types';

export const entityResolver = {
  async fromIsbn(isbn: string): Promise<RawBook> {
    console.log(`[RESOLVER] Début résolution ISBN: ${isbn}`);
    const res = await fetch(`/api/data/isbn?isbn=${isbn}`);
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || "Livre introuvable sur Inventaire.io");

    const entityUri = Object.keys(data.entities)[0];
    if (!entityUri) throw new Error("Aucune entité trouvée pour cet ISBN.");

    const rawEntity = data.entities[entityUri];
    let book = entityMapper.mapResponse(entityUri, rawEntity);

    // Fallback vers l'œuvre si l'édition est incomplète
    if (!book.seriesId && book.type === 'edition') {
      const workUri = rawEntity.claims?.['wdt:P629']?.[0];
      if (workUri) {
        const workRes = await fetch(`/api/entities/by-uris?uris=${workUri}`);
        const workData = await workRes.json();
        const workEntity = workData.entities?.[workUri] || workData[workUri];

        if (workEntity) {
          const workBook = entityMapper.mapResponse(workUri, workEntity);
          book = {
            ...book,
            seriesId: workBook.seriesId || book.seriesId,
            seriesNumber: workBook.seriesNumber || book.seriesNumber,
            authorIds: book.authorIds.length ? book.authorIds : workBook.authorIds,
            genreIds: book.genreIds.length ? book.genreIds : workBook.genreIds,
          };
        }
      }
    }

    return book;
  },

  /**
   * Trouve l'édition la plus récente pour une Œuvre donnée.
   */
  async getBestEdition(workUri: string): Promise<string> {
    try {
      const resEditions = await fetch(`/api/entities/editions?workId=${encodeURIComponent(workUri)}`);
      const dataEditions = await resEditions.json();
      const editionUris = dataEditions.uris || [];

      if (editionUris.length <= 1) return editionUris[0] || workUri;

      const resData = await fetch(`/api/entities/by-uris?uris=${encodeURIComponent(editionUris.join('|'))}&attributes=claims`);
      const entitiesData = await resData.json();
      const entities = entitiesData.entities || entitiesData;

      let latestUri = editionUris[0];
      let latestDate = "";

      editionUris.forEach((uri: string) => {
        const date = entities[uri]?.claims?.['wdt:P577']?.[0] || "";
        if (date > latestDate) {
          latestDate = date;
          latestUri = uri;
        }
      });

      return latestUri;
    } catch (error) {
      console.error(`[RESOLVER] Erreur de résolution d'édition pour ${workUri}:`, error);
      return workUri;
    }
  },

  /**
   * Convertit une liste d'œuvres en une liste d'éditions (Batch)
   */
  async resolveBestEditions(workUris: string[]): Promise<string[]> {
    const results: string[] = [];
    for (const workUri of workUris) {
      results.push(await this.getBestEdition(workUri));
      await new Promise(r => setTimeout(r, 100)); // Protection API
    }
    return results;
  }
};