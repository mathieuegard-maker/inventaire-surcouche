// src/resolvers/series.resolver.ts
import { entityMapper } from './mapper';
import { entityHumanizer } from './humanizer';
import type { HumanizedBook } from './types';

export const seriesResolver = {
  /**
   * ÉTAPE 1 : Récupère la liste brute des identifiants (Q...) d'une série.
   */
  async getTomes(seriesId: string): Promise<string[]> {
    const res = await fetch(`/api/series/list?seriesId=${encodeURIComponent(seriesId)}`);
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || "Impossible de récupérer la série");
    
    return data.tomes || [];
  },

  /**
   * ÉTAPE 2 : Récupère, structure, traduit et trie TOUS les tomes d'une série d'un seul coup.
   */
  async getFullSeries(seriesId: string): Promise<HumanizedBook[]> {
    // 1. Récupération des IDs bruts de la série
    const tomeUris = await this.getTomes(seriesId);
    if (tomeUris.length === 0) return [];

    // 2. Traitement BATCH : 1 seul appel API pour récupérer les données de tous les tomes
    const urisParam = encodeURIComponent(tomeUris.join('|'));
    const res = await fetch(`/api/entities/by-uris?uris=${urisParam}`);
    const data = await res.json();
    const entities = data.entities || data;

    const fullTomes: HumanizedBook[] = [];

    // 3. Transformation de chaque entité brute en objet HumanizedBook
    for (const uri of tomeUris) {
      const rawEntity = entities[uri];
      if (rawEntity) {
        // Mapping des propriétés brutes
        const rawBook = entityMapper.mapResponse(uri, rawEntity);
        // Traduction humaine (Auteurs, Genres, etc.)
        const humanizedBook = await entityHumanizer.humanize(rawBook);
        fullTomes.push(humanizedBook);
      }
    }

    // 4. Tri par numéro de tome (seriesNumber) pour l'ordre chronologique
    fullTomes.sort((a, b) => {
      const numA = parseInt(a.seriesNumber || '999', 10);
      const numB = parseInt(b.seriesNumber || '999', 10);
      return numA - numB;
    });

    return fullTomes;
  }
};