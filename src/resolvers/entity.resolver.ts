// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from './types';

export const entityResolver = {
  async fromIsbn(isbn: string): Promise<RawBook> {
    const res = await fetch(`/api/data/isbn?isbn=${isbn}`);
    const data = await res.json();
    const entities = data.entities || data;
    const uri = Object.keys(entities)[0];
    const rawEdition = entities[uri];

    if (!rawEdition || rawEdition.missing) throw new Error("Livre introuvable");

    let mappedBook = entityMapper.mapResponse(uri, rawEdition);

    // INTELLIGENCE NIVEAU 1 : Si pas d'auteur ou de série, on cherche le lien vers l'Œuvre (Work)
    const workUri = rawEdition.claims?.['wdt:P629']?.[0] || rawEdition.work;

    if (workUri && (mappedBook.authorIds.length === 0 || !mappedBook.seriesId)) {
      console.log(`[Resolver] Édition incomplète. Récupération de l'œuvre : ${workUri}`);
      const workRes = await fetch(`/api/entities/by-uris?uris=${workUri}`);
      const workData = await workRes.json();
      const rawWork = (workData.entities || workData)[workUri];

      if (rawWork) {
        const mappedWork = entityMapper.mapResponse(workUri, rawWork);
        mappedBook.authorIds = mappedBook.authorIds.length > 0 ? mappedBook.authorIds : mappedWork.authorIds;
        mappedBook.illustratorIds = mappedBook.illustratorIds.length > 0 ? mappedBook.illustratorIds : mappedWork.illustratorIds;
        mappedBook.scriptwriterIds = mappedBook.scriptwriterIds.length > 0 ? mappedBook.scriptwriterIds : mappedWork.scriptwriterIds;
        mappedBook.seriesId = mappedBook.seriesId || mappedWork.seriesId;
        mappedBook.seriesNumber = mappedBook.seriesNumber || mappedWork.seriesNumber;
        mappedBook.genreIds = mappedBook.genreIds.length > 0 ? mappedBook.genreIds : mappedWork.genreIds;
      }
    }

    // INTELLIGENCE NIVEAU 2 : Si TOUJOURS pas d'auteur, on remonte jusqu'à la Série
    if (mappedBook.seriesId && mappedBook.authorIds.length === 0 && mappedBook.illustratorIds.length === 0) {
      console.log(`[Resolver] Œuvre sans auteur. Récupération de la série parente : ${mappedBook.seriesId}`);
      const seriesRes = await fetch(`/api/entities/by-uris?uris=${mappedBook.seriesId}`);
      const seriesData = await seriesRes.json();
      const rawSeries = (seriesData.entities || seriesData)[mappedBook.seriesId];

      if (rawSeries) {
         const mappedSeries = entityMapper.mapResponse(mappedBook.seriesId, rawSeries);
         mappedBook.authorIds = mappedSeries.authorIds;
         mappedBook.illustratorIds = mappedSeries.illustratorIds;
         mappedBook.scriptwriterIds = mappedSeries.scriptwriterIds;
         mappedBook.genreIds = mappedBook.genreIds.length > 0 ? mappedBook.genreIds : mappedSeries.genreIds;
      }
    }

    return mappedBook;
  }
};