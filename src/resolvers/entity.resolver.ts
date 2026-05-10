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

    // INTELLIGENCE : Si pas d'auteur ou de série, on cherche le lien vers l'Œuvre (Work)
    // Dans Inventaire, le lien vers l'œuvre est souvent dans claims['wdt:P629'] (edition of)
    const workUri = rawEdition.claims?.['wdt:P629']?.[0] || rawEdition.work;

    if (workUri && (mappedBook.authorIds.length === 0 || !mappedBook.seriesId)) {
      console.log(`[Resolver] Edition incomplète. Récupération de l'œuvre : ${workUri}`);
      const workRes = await fetch(`/api/entities/by-uris?uris=${workUri}`);
      const workData = await workRes.json();
      const rawWork = (workData.entities || workData)[workUri];

      if (rawWork) {
        const mappedWork = entityMapper.mapResponse(workUri, rawWork);
        // On fusionne : on garde les infos de l'édition mais on complète avec l'œuvre
        mappedBook.authorIds = mappedBook.authorIds.length > 0 ? mappedBook.authorIds : mappedWork.authorIds;
        mappedBook.seriesId = mappedBook.seriesId || mappedWork.seriesId;
        mappedBook.seriesNumber = mappedBook.seriesNumber || mappedWork.seriesNumber;
        mappedBook.illustratorIds = mappedBook.illustratorIds.length > 0 ? mappedBook.illustratorIds : mappedWork.illustratorIds;
        mappedBook.genreIds = mappedBook.genreIds.length > 0 ? mappedBook.genreIds : mappedWork.genreIds;
      }
    }

    return mappedBook;
  }
};