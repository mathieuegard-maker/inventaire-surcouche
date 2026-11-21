// src/core/bibliographic/work-identity.ts
// Primitives bibliographiques partagées d'identité d'œuvre, d'intégrale, de série et d'anti-homonymie.
// 100 % portable (aucune dépendance Cloudflare ni DOM).

import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import type { ExternalBookMetadata } from '../types';
import { isEditorialPaperbackCollectionName } from '../utils/editorial-collection.util';
import { stripEditorialCollectionSuffixes } from '../utils/series-matcher.util';
import { getLevenshteinDistance } from '../utils/string.util';

/**
 * Vérifie si deux libellés partagent une inclusion ou au moins un token significatif (>= 3 car.).
 */
export function hasTextTokenOverlap(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  const normA = normalizeTextKey(a);
  const normB = normalizeTextKey(b);
  if (!normA || !normB) return false;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  const tokensA = normA.split(/\s+/).filter((t) => t.length >= 3);
  const tokensB = new Set(normB.split(/\s+/).filter((t) => t.length >= 3));
  return tokensA.some((t) => tokensB.has(t));
}

/**
 * Vérifie si deux listes d'auteurs partagent au moins un nom significatif (>= 3 car.).
 */
export function hasAuthorOverlap(candAuthors?: string[], expectedAuthors?: string[]): boolean {
  if (!candAuthors?.length || !expectedAuthors?.length) return false;
  const expectedTokens = new Set(
    expectedAuthors
      .flatMap((a) => normalizeTextKey(a).split(/\s+/))
      .filter((t) => t.length >= 3 && t !== 'auteur' && t !== 'inconnu')
  );
  if (expectedTokens.size === 0) return false;
  return candAuthors.some((ca) =>
    normalizeTextKey(ca)
      .split(/\s+/)
      .some((t) => t.length >= 3 && expectedTokens.has(t))
  );
}

/**
 * Détermine si une métadonnée désigne explicitement une Intégrale / Coffret / Omnibus / Compilation.
 * Règle stricte : ne JAMAIS déduire une intégrale de la seule pagination (>= 180 pages) ni de « texte intégral ».
 */
export function isMetaIntegral(
  meta: Pick<ExternalBookMetadata, 'isIntegral' | 'title' | 'collection'>
): boolean {
  const combined = `${meta.title || ''} ${meta.collection || ''}`.replace(
    /\b(?:texte|version)\s+int[ée]grale?\b/gi,
    ' '
  );
  return Boolean(
    meta.isIntegral ||
      /(?:l['’]?\s*int[ée]grale|\bint[ée]grale?\b|\bcoffret\b|\bomnibus\b|\bcompil\b|\btomes?\s+\d+\s*(?:[àa]|et|&|-|\/)\s*\d+)/i.test(
        combined
      )
  );
}

function extractVolumeFromTitle(title?: string): string {
  if (!title) return '';
  const m = title.match(/(?:n°|no|tome|t\.?)\s*(\d+)/i) || title.match(/\s(\d{1,3})$/);
  return m ? normalizeSeriesNumber(m[1]) : '';
}

/**
 * Calcule une clé canonique d'œuvre (WorkKey) partagée entre le Canal 3 serveur et client.
 */
export function computeCanal3WorkKey(
  meta: Pick<ExternalBookMetadata, 'title' | 'series' | 'seriesNumber' | 'authors' | 'collection' | 'isIntegral'>,
  fallbackVolumeNumber?: string
): string {
  const isInt = isMetaIntegral(meta);
  const normSeries = meta.series ? stripEditorialCollectionSuffixes(meta.series).coreKey : '';
  const normVol =
    (meta.seriesNumber ? normalizeSeriesNumber(meta.seriesNumber) : '') ||
    extractVolumeFromTitle(meta.title) ||
    (fallbackVolumeNumber ? normalizeSeriesNumber(fallbackVolumeNumber) : '');
  const normTitle = normalizeTextKey(meta.title || '');

  if (isInt) {
    return `integral:${normSeries || normTitle}:${normVol || normTitle}`;
  }
  if (normSeries && normVol) return `series:${normSeries}#${normVol}`;
  if (!normSeries && normVol && normTitle) {
    const titleCore = stripEditorialCollectionSuffixes(meta.title || '').coreKey;
    if (titleCore) return `series:${titleCore}#${normVol}`;
  }
  const normAuthor = meta.authors?.[0] ? normalizeTextKey(meta.authors[0]).split(' ')[0] : '';
  if (normTitle && normVol) return `title:${normTitle}#${normVol}`;
  return normTitle ? `title:${normTitle}${normAuthor ? `|${normAuthor}` : ''}` : '';
}

/**
 * Étend la détection des collections éditoriales de poche par une vérification structurelle :
 * si le nom de série candidat coïncide directement avec le nom de l'éditeur du livre, il s'agit d'une collection éditoriale.
 */
export function isEditorialOrPublisherCollection(rawSeries?: string, publisherHint?: string): boolean {
  if (!rawSeries?.trim()) return false;
  if (isEditorialPaperbackCollectionName(rawSeries)) return true;
  if (publisherHint?.trim()) {
    const sNorm = normalizeTextKey(rawSeries).replace(/^(?:la\s+)?(?:collection|editions?)\s+/, '').trim();
    const pNorm = normalizeTextKey(publisherHint).replace(/^(?:les\s+)?editions?\s+/, '').trim();
    if (sNorm.length >= 3 && pNorm.length >= 3 && sNorm === pNorm) {
      return true;
    }
  }
  return false;
}

/**
 * Règle générale anti-homonymie pour les recherches de repli d'une série (hors notice d'ensemble `bib.ens2bib`).
 * Empêche qu'un ouvrage homonyme d'un autre auteur ne soit rattaché à une série courte sur un simple préfixe de titre.
 */
export function matchesSeriesFallbackCandidate(params: {
  candSeriesRaw?: string;
  candTitle: string;
  candAuthors?: string[];
  candVolumeNumber?: string;
  candIsIntegral?: boolean;
  targetCoreKey: string;
  expectedAuthors: string[];
}): boolean {
  const {
    candSeriesRaw,
    candTitle,
    candAuthors,
    candVolumeNumber,
    candIsIntegral,
    targetCoreKey,
    expectedAuthors
  } = params;

  if (expectedAuthors.length > 0 && candAuthors && candAuthors.length > 0 && !hasAuthorOverlap(candAuthors, expectedAuthors)) {
    return false;
  }

  const candSeriesCore = candSeriesRaw ? stripEditorialCollectionSuffixes(candSeriesRaw).coreKey : '';
  const candTitleCore = stripEditorialCollectionSuffixes(candTitle).coreKey;

  const matchesExplicitSeries = Boolean(
    candSeriesCore &&
      (candSeriesCore === targetCoreKey ||
        candSeriesCore.includes(targetCoreKey) ||
        targetCoreKey.includes(candSeriesCore) ||
        (targetCoreKey.length >= 4 && getLevenshteinDistance(candSeriesCore, targetCoreKey) <= 2))
  );

  const authorConfirmed = hasAuthorOverlap(candAuthors, expectedAuthors);
  const matchesTitleWithContext = Boolean(
    candTitleCore &&
      (candTitleCore === targetCoreKey || candTitleCore.startsWith(`${targetCoreKey} `)) &&
      (authorConfirmed || Boolean(candVolumeNumber) || Boolean(candIsIntegral))
  );

  return matchesExplicitSeries || matchesTitleWithContext;
}
