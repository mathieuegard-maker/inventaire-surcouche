// src/resolvers/entity.resolver.ts
import { entityMapper } from './mapper';
import type { RawBook } from './types';

export const entityResolver = {
  async fromIsbn(isbn: string): Promise<RawBook> {
    console.log(`[RESOLVER] Début résolution ISBN: ${isbn}`);
    const res = await fetch(`/api/data/isbn?isbn=${isbn}`);
    const data = await res.json();
    console.log(`[RESOLVER] Données ISBN brutes API:`, data);
    
    const entities = data.entities || data;
    const uri = Object.keys(entities)[0];
    const rawEdition = entities[uri];

    if (!rawEdition || rawEdition.missing) {
      console.error(`[RESOLVER] Erreur : L'édition est manquante ou introuvable pour ${isbn}`);
      throw new Error("Livre introuvable");
    }

    let mappedBook = entityMapper.mapResponse(uri, rawEdition);

    // INTELLIGENCE : Si pas d'auteur ou de série, on cherche le lien vers l'Œuvre (Work)
    const workUri = rawEdition.claims?.['wdt:P629']?.[0] || rawEdition.work;

    if (workUri && (mappedBook.authorIds.length === 0 || !mappedBook.seriesId)) {
      console.log(`[RESOLVER] Édition incomplète détectée. Fallback vers l'œuvre : ${workUri}`);
      const workRes = await fetch(`/api/entities/by-uris?uris=${workUri}`);
      const workData = await workRes.json();
      const rawWork = (workData.entities || workData)[workUri];

      if (rawWork) {
        console.log(`[RESOLVER] Données de l'œuvre reçues :`, rawWork);
        const mappedWork = entityMapper.mapResponse(workUri, rawWork);

        // Fusion en préservant l'existant
        mappedBook.authorIds = mappedBook.authorIds.length > 0 ? mappedBook.authorIds : mappedWork.authorIds;
        mappedBook.seriesId = mappedBook.seriesId || mappedWork.seriesId;
        mappedBook.seriesNumber = mappedBook.seriesNumber || mappedWork.seriesNumber;
        mappedBook.illustratorIds = mappedBook.illustratorIds.length > 0 ? mappedBook.illustratorIds : mappedWork.illustratorIds;
        mappedBook.scriptwriterIds = mappedBook.scriptwriterIds.length > 0 ? mappedBook.scriptwriterIds : mappedWork.scriptwriterIds;
        mappedBook.genreIds = mappedBook.genreIds.length > 0 ? mappedBook.genreIds : mappedWork.genreIds;
        
        console.log(`[RESOLVER] Résultat de la fusion (seriesId final : ${mappedBook.seriesId})`);
      }
    }

    console.log(`[RESOLVER] Objet final renvoyé par fromIsbn :`, mappedBook);
    return mappedBook;
  }
};