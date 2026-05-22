// src/core/resolvers/workUri.resolver.ts
import { databaseService } from '../database/database.service';

/**
 * Calcule la distance de Levenshtein entre deux chaînes (Score de similarité)
 */
function getEditDistance(a: string, b: string): number {
  if (!a) return b ? b.length : 0;
  if (!b) return a ? a.length : 0;
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i++) matrix[i] = [i];
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }
  return matrix[a.length][b.length];
}

export const workUriResolver = {
  /**
   * Convertit une liste d'œuvres (wd:) en la meilleure liste d'éditions physiques (inv: ou isbn:)
   */
  async resolveBulk(workUris: string[]): Promise<string[]> {
    console.group(`[WORK-URI RESOLVER] Concrétisation de ${workUris.length} œuvres...`);
    const physicalUris: string[] = [];
    const missingWorks: string[] = [];

    // 1. Barrière Locale (Cache-First)
    for (const uri of workUris) {
      if (!uri.startsWith('wd:')) {
        physicalUris.push(uri); // C'est déjà une édition physique
        continue;
      }
      const editionLocal = await databaseService.getEditionByWorkFromCache(uri);
      if (editionLocal) {
        physicalUris.push(editionLocal.uri);
      } else {
        missingWorks.push(uri);
      }
    }

    if (missingWorks.length === 0) {
      console.log('[WORK-URI RESOLVER] 100% résolu depuis le cache local.');
      console.groupEnd();
      return physicalUris;
    }

    console.log(`[WORK-URI RESOLVER] ${missingWorks.length} œuvres nécessitent une résolution réseau...`);

    // 2. Résolution Réseau Groupée (Reverse-claims)
    const workToEditionsMap: Record<string, string[]> = {};
    const allEditionUrisToFetch = new Set<string>();

    await Promise.all(missingWorks.map(async (workUri) => {
      try {
        const res = await fetch(`https://inventaire.io/api/entities?action=reverse-claims&property=wdt:P629&value=${workUri}`);
        const data = await res.json();
        const uris = data.uris || [];
        workToEditionsMap[workUri] = uris;
        uris.forEach((u: string) => allEditionUrisToFetch.add(u));
      } catch (e) {
        console.error(`[WORK-URI RESOLVER] Erreur reverse-claims pour ${workUri}`, e);
        workToEditionsMap[workUri] = [];
      }
    }));

    // 3. Récupération des Labels pour l'analyse sémantique (Mega-Batching)
    const JUNK_REGEX = /intégrale|coffret|box\s*set|pack|compilation/i;
    const editionDataMap: Record<string, any> = {};
    const urisArray = Array.from(allEditionUrisToFetch);
    const CHUNK_SIZE = 50;

    for (let i = 0; i < urisArray.length; i += CHUNK_SIZE) {
      const chunk = urisArray.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}&attributes=labels`);
        const data = await res.json();
        Object.assign(editionDataMap, data.entities || {});
      } catch (e) {
        console.error(`[WORK-URI RESOLVER] Erreur fetch labels éditions`, e);
      }
    }

    const workDataMap: Record<string, any> = {};
    for (let i = 0; i < missingWorks.length; i += CHUNK_SIZE) {
      const chunk = missingWorks.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}&attributes=labels`);
        const data = await res.json();
        Object.assign(workDataMap, data.entities || {});
      } catch (e) {}
    }

    // 4. Élection de l'édition canonique
    for (const workUri of missingWorks) {
      const editions = workToEditionsMap[workUri] || [];
      if (editions.length === 0) continue; 

      // Fast-Path
      if (editions.length === 1) {
        physicalUris.push(editions[0]);
        continue;
      }

      const workLabel = workDataMap[workUri]?.labels?.fr || workDataMap[workUri]?.labels?.en || workDataMap[workUri]?.label || '';

      // Critère 1 : Filtrage par Regex (anti-bruit)
      const validEditions = editions.filter(edUri => {
        const edData = editionDataMap[edUri];
        if (!edData) return false;
        const edLabel = edData.labels?.fr || edData.labels?.en || edData.label || '';
        return !JUNK_REGEX.test(edLabel);
      });

      // Si la regex a tout supprimé, on annule le filtre par sécurité
      let targetEditions = validEditions.length > 0 ? validEditions : editions;

      // Critère 2 : Priorité stricte aux URIs natives (inv:) sur les entités génériques (wd:)
      const nativeEditions = targetEditions.filter(edUri => edUri.startsWith('inv:'));
      
      // Si on trouve au moins une édition "inv:", on évince définitivement les "wd:"
      if (nativeEditions.length > 0) {
        targetEditions = nativeEditions;
      }

      // Re-Fast-Path après filtrages
      if (targetEditions.length === 1) {
        physicalUris.push(targetEditions[0]);
        continue;
      }

      // Critère 3 : Scoring de similarité (Levenshtein) sur la liste finale restante
      let bestUri = targetEditions[0];
      let bestScore = Infinity;

      for (const edUri of targetEditions) {
        const edData = editionDataMap[edUri];
        const edLabel = edData?.labels?.fr || edData?.labels?.en || edData?.label || '';
        const score = getEditDistance(workLabel, edLabel);
        if (score < bestScore) {
          bestScore = score;
          bestUri = edUri;
        }
      }
      physicalUris.push(bestUri);
    }

    console.groupEnd();
    return physicalUris;
  }
};