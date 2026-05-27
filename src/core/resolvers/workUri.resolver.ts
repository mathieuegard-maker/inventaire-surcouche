// src/core/resolvers/workUri.resolver.ts
import { databaseService } from '../database/database.service';
import { configService } from '../services/config.service';

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

/**
 * Extrait intelligemment le titre d'une entité selon son format (Wikidata ou Inventaire natif)
 */
function extractEntityTitle(entity: any): string {
  if (!entity) return '';
  
  // 1. Format Inventaire natif : un simple tableau de strings
  if (entity.claims && entity.claims['wdt:P1476']) {
    const titleClaim = entity.claims['wdt:P1476'][0];
    
    // Si la donnée est directement le texte (ex: ["Universal War One"])
    if (typeof titleClaim === 'string') {
      return titleClaim;
    }
    
    // Au cas où ce serait le format complexe Wikidata standard
    const complexTitle = titleClaim?.mainsnak?.datavalue?.value?.text || titleClaim?.datavalue?.value?.text || titleClaim?.value;
    if (complexTitle && typeof complexTitle === 'string') {
      return complexTitle;
    }
  }

  // 2. Format classique Wikidata (dans le noeud labels)
  if (entity.labels) {
    if (entity.labels.fr) return typeof entity.labels.fr === 'string' ? entity.labels.fr : entity.labels.fr.value;
    if (entity.labels.en) return typeof entity.labels.en === 'string' ? entity.labels.en : entity.labels.en.value;
  }
  
  // 3. Dernier recours (fallback global)
  if (entity.label && typeof entity.label === 'string') {
    return entity.label;
  }
  
  return '';
}

/**
 * Vérifie si une édition est dans la langue souhaitée
 */
function hasLanguage(entity: any, expectedWdId: string): boolean {
  if (!entity?.claims) return false;
  // P407 = langue de l'œuvre, P364 = langue originale de l'œuvre
  const langClaims = entity.claims['wdt:P407'] || entity.claims['wdt:P364']; 
  if (!langClaims) return false;
  
  for (const claim of langClaims) {
    if (typeof claim === 'string' && claim === expectedWdId) return true;
    if (claim?.value === expectedWdId) return true;
    if (claim?.mainsnak?.datavalue?.value?.id === expectedWdId) return true;
    if (claim?.datavalue?.value?.id === expectedWdId) return true;
  }
  return false;
}

/**
 * FACTORISATION CONCEPTRICE : Élit la meilleure édition physique canonique pour un Work donné
 * en appliquant de manière centralisée les règles de langue, de filtrage anti-bruit et de score de proximité.
 */
function electBestEdition(
  workUri: string,
  editions: string[],
  editionDataMap: Record<string, any>,
  workLabel: string,
  preferredLangWd: string
): string {
  if (editions.length === 0) return workUri;
  if (editions.length === 1) return editions[0];

  // REGEX UNIQUE : Exclusion des intégrales et des intervalles de tomes génériques (ex: tomes 1-3)
  const JUNK_REGEX = /intégrale|coffret|box\s*set|pack|compilation|tomes?\s*\d+\s*[-–至àa]\s*\d+|vols?\s*\d+\s*[-–至àa]\s*\d+/i;

  // CRITÈRE 0 : Barrière de la Langue (Priorité absolue)
  const langEditions = editions.filter(edUri => hasLanguage(editionDataMap[edUri], preferredLangWd));
  let targetEditions = langEditions.length > 0 ? langEditions : editions;

  // Critère 1 : Filtrage par Regex (anti-bruit)
  const validEditions = targetEditions.filter(edUri => {
    const edData = editionDataMap[edUri];
    if (!edData) return false;
    const edLabel = extractEntityTitle(edData);
    return !JUNK_REGEX.test(edLabel);
  });

  // Si la regex a tout supprimé, on annule le filtre par sécurité
  targetEditions = validEditions.length > 0 ? validEditions : targetEditions;

  // Structure intermédiaire de notation
  interface EditionScore {
    uri: string;
    score: number;
    isNative: boolean;
  }

  // Calcul des scores de distance de Levenshtein pour tous les candidats restants
  const scoredEditions: EditionScore[] = targetEditions.map(edUri => {
    const edData = editionDataMap[edUri];
    const edLabel = extractEntityTitle(edData);
    const score = getEditDistance(workLabel, edLabel);
    return {
      uri: edUri,
      score,
      isNative: edUri.startsWith('inv:')
    };
  });

  // Tri par pertinence textuelle pure (ascendant)
  scoredEditions.sort((a, b) => a.score - b.score);

  // Algorithme de la petite boucle : on cherche la première édition native 'inv:' disponible dans l'ordre de pertinence
  for (const candidate of scoredEditions) {
    if (candidate.isNative) {
      return candidate.uri;
    }
  }

  // Si aucune édition native 'inv:' n'a été trouvée, on se replie sur le vainqueur textuel absolu
  return scoredEditions[0]?.uri || workUri;
}

export const workUriResolver = {
  /**
   * Convertit une liste d'œuvres en la meilleure liste d'éditions physiques correspondantes (inv: ou isbn:)
   */
  async resolveBulk(workUris: string[]): Promise<string[]> {
    console.group(`[WORK-URI RESOLVER] Concrétisation de ${workUris.length} œuvres...`);
    const physicalUris: string[] = [];
    const missingWorks: string[] = [];
    
    const preferredLangWd = configService.getPreferredLanguageWdCode();

    // 1. Barrière Locale (Cache-First) adaptative
    for (const uri of workUris) {
      if (uri.startsWith('isbn:')) {
        physicalUris.push(uri); // C'est déjà une édition physique pure garantie
        continue;
      }
      
      const editionLocal = await databaseService.getEditionByWorkFromCache(uri);
      if (editionLocal) {
        physicalUris.push(editionLocal.uri);
      } else {
        // Les identifiants wd: ET inv: d'œuvres natives partent à la résolution réseau
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

    // 3. Récupération des données pour l'analyse sémantique
    const editionDataMap: Record<string, any> = {};
    const urisArray = Array.from(allEditionUrisToFetch);
    const CHUNK_SIZE = 50;

    for (let i = 0; i < urisArray.length; i += CHUNK_SIZE) {
      const chunk = urisArray.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
        const data = await res.json();
        Object.assign(editionDataMap, data.entities || {});
      } catch (e) {
        console.error(`[WORK-URI RESOLVER] Erreur fetch données éditions`, e);
      }
    }

    const workDataMap: Record<string, any> = {};
    for (let i = 0; i < missingWorks.length; i += CHUNK_SIZE) {
      const chunk = missingWorks.slice(i, i + CHUNK_SIZE);
      try {
        const res = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
        const data = await res.json();
        Object.assign(workDataMap, data.entities || {});
      } catch (e) {}
    }

    // 4. Élection de l'édition canonique via la logique factorisée pure
    for (const workUri of missingWorks) {
      const editions = workToEditionsMap[workUri] || [];
      const workLabel = extractEntityTitle(workDataMap[workUri]);

      const chosenUri = electBestEdition(workUri, editions, editionDataMap, workLabel, preferredLangWd);
      physicalUris.push(chosenUri);
    }

    console.groupEnd();
    return physicalUris;
  },

  /**
   * Pivot sémantique d'une œuvre : Scanne et élit l'édition la plus légitime d'une œuvre
   * pour en extraire l'ISBN-13 ou ISBN-10 (Passerelle parfaite vers l'acquisition physique)
   */
  async resolveIsbnFromWorkUri(workUri: string): Promise<string | undefined> {
    try {
      // 1. Barrière de Cache
      const editionLocal = await databaseService.getEditionByWorkFromCache(workUri);
      if (editionLocal && editionLocal.isbn13) {
        return editionLocal.isbn13;
      }

      const preferredLangWd = configService.getPreferredLanguageWdCode();

      // 2. Extraction du titre de référence de l'œuvre
      const resWork = await fetch(`/api/gateway?action=entities-by-uris&uris=${encodeURIComponent(workUri)}`);
      const dataWork = await resWork.json();
      const workDataMap = dataWork.entities || {};
      const workLabel = extractEntityTitle(workDataMap[workUri]);

      // 3. Récupération des éditions candidates rattachées (Reverse-claims)
      const resEditions = await fetch(`https://inventaire.io/api/entities?action=reverse-claims&property=wdt:P629&value=${workUri}`);
      const dataEditions = await resEditions.json();
      const editions: string[] = dataEditions.uris || [];
      if (editions.length === 0) return undefined;

      // 4. Chargement des métadonnées des 50 premières éditions pour arbitrage
      const chunk = editions.slice(0, 50);
      const resData = await fetch(`https://inventaire.io/api/entities?action=by-uris&uris=${encodeURIComponent(chunk.join('|'))}`);
      const dataJson = await resData.json();
      const editionDataMap = dataJson.entities || {};

      // 5. Arbitrage via notre entonnoir algorithmique factorisé commun
      const chosenUri = electBestEdition(workUri, chunk, editionDataMap, workLabel, preferredLangWd);
      
      // 6. Extraction sécurisée de l'ISBN sur l'édition élue
      const electedData = editionDataMap[chosenUri];
      if (!electedData?.claims) return undefined;

      const isbn13Claim = electedData.claims['wdt:P212']?.[0] || electedData.claims['P212']?.[0];
      const isbn10Claim = electedData.claims['wdt:P957']?.[0] || electedData.claims['P957']?.[0];
      
      const rawIsbn = typeof isbn13Claim === 'string' ? isbn13Claim : (isbn13Claim?.value || isbn13Claim?.url);
      const rawIsbn10 = typeof isbn10Claim === 'string' ? isbn10Claim : (isbn10Claim?.value || isbn10Claim?.url);
      
      return rawIsbn || rawIsbn10 || undefined;
    } catch (e) {
      console.error(`[WORK-URI RESOLVER] Erreur pivot ISBN pour l'œuvre ${workUri}`, e);
    }
    return undefined;
  }
};