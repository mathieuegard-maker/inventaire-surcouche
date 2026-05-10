// src/resolvers/series.resolver.ts
import { entityMapper } from './mapper';
import type { HumanizedBook } from './types';

export const seriesResolver = {
  async getFullSeries(seriesId: string): Promise<HumanizedBook[]> {
    // 1. Liste des IDs via notre nouveau proxy Inventaire
    const resList = await fetch(`/api/series/list?seriesId=${encodeURIComponent(seriesId)}`);
    const { tomes: tomeUris } = await resList.json();
    if (!tomeUris || tomeUris.length === 0) return [];

    // 2. Récupération des données brutes (1 seul appel)
    const resData = await fetch(`/api/entities/by-uris?uris=${encodeURIComponent(tomeUris.join('|'))}`);
    const data = await resData.json();
    const entities = data.entities || data;

    // 3. MEGA-BATCH : On collecte TOUS les IDs à traduire de TOUS les tomes
    const idsToTranslate = new Set<string>();
    const rawBooks = tomeUris.map((uri: string) => {
      const raw = entityMapper.mapResponse(uri, entities[uri]);
      [...raw.authorIds, ...raw.illustratorIds, ...raw.scriptwriterIds, ...raw.genreIds, raw.seriesId].forEach(id => {
        if (id) idsToTranslate.add(id);
      });
      return raw;
    });

    // 4. TRADUCTION UNIQUE : 1 seul appel pour tous les noms de la série
    const resTrans = await fetch(`/api/entities/by-uris?uris=${encodeURIComponent(Array.from(idsToTranslate).join('|'))}`);
    const transData = await resTrans.json();
    const transEntities = transData.entities || transData;

    const getName = (id?: string) => {
      const e = transEntities[id || ''];
      return e ? (e.label || e.labels?.fr || id) : id;
    };

    // 5. ASSEMBLAGE FINAL
    const fullTomes: HumanizedBook[] = rawBooks.map(raw => {
      const authors = raw.authorIds.map(id => getName(id)!);
      const scripts = raw.scriptwriterIds.map(id => getName(id)!);
      const illusts = raw.illustratorIds.map(id => getName(id)!);

      return {
        ...raw,
        authors: authors.length > 0 ? authors : Array.from(new Set([...scripts, ...illusts])),
        genres: raw.genreIds.map(id => getName(id)!),
        series: getName(raw.seriesId),
        publisher: getName(raw.publisherId),
        illustrators: illusts,
        scriptwriters: scripts
      };
    });

    return fullTomes.sort((a, b) => parseInt(a.seriesNumber || '999') - parseInt(b.seriesNumber || '999'));
  }
};