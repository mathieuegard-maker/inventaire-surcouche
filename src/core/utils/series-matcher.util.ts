// src/core/utils/series-matcher.util.ts
// Rapprochement orienté Œuvre (Work-first) pour éviter la création de séries doublons
// causée par les noms de collections éditoriales (ex: "Astérix - La Grande Collection" vs "Une aventure d'Astérix").

import { normalizeTextKey } from '../resolvers/bnf.resolver';

const EDITORIAL_COLLECTION_MARKERS = [
  'la grande collection',
  'grande collection',
  'edition luxe',
  'edition collector',
  'collector',
  'integrale',
  'coffret',
  'poche',
  'edition speciale',
  'hors serie',
  'hachette',
  'classique',
  'folio',
  'livre de poche'
];

const SERIES_LEADING_PREFIXES = [
  'une aventure d ',
  'une aventure de ',
  'les aventures d ',
  'les aventures de ',
  'une histoire d ',
  'une histoire de ',
  'le cycle d ',
  'le cycle de ',
  'la saga ',
  'saga '
];

export function stripEditorialCollectionSuffixes(rawSeries: string): {
  cleanDisplay: string;
  coreKey: string;
} {
  let display = (rawSeries || '').replace(/\s+/g, ' ').trim();
  if (!display) return { cleanDisplay: '', coreKey: '' };

  // Retirer les segments après "-" ou ":" ou "(...)" contenant un marqueur de collection éditoriale
  const normFull = normalizeTextKey(display);
  for (const marker of EDITORIAL_COLLECTION_MARKERS) {
    if (normFull.includes(marker)) {
      const splitDash = display.split(/\s+[-–—:]\s+/);
      if (splitDash.length > 1 && normalizeTextKey(splitDash[splitDash.length - 1]).includes(marker)) {
        display = splitDash.slice(0, -1).join(' - ').trim();
      }
      display = display.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  let coreKey = normalizeTextKey(display);
  for (const prefix of SERIES_LEADING_PREFIXES) {
    if (coreKey.startsWith(prefix)) {
      coreKey = coreKey.slice(prefix.length).trim();
      break;
    }
  }
  for (const marker of EDITORIAL_COLLECTION_MARKERS) {
    if (coreKey.endsWith(` ${marker}`)) {
      coreKey = coreKey.slice(0, -(marker.length + 1)).trim();
    }
  }

  return { cleanDisplay: display || rawSeries.trim(), coreKey };
}

function extractAuthorTokens(authors?: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const raw of authors || []) {
    const norm = normalizeTextKey(raw);
    for (const tok of norm.split(' ')) {
      if (tok.length >= 3 && tok !== 'auteur' && tok !== 'inconnu') {
        tokens.add(tok);
      }
    }
  }
  return tokens;
}

function hasAuthorOverlap(a?: string[], b?: string[]): boolean {
  const ta = extractAuthorTokens(a);
  const tb = extractAuthorTokens(b);
  if (ta.size === 0 || tb.size === 0) return true; // Si l'un des deux n'a pas d'auteur connu, ne pas bloquer
  for (const tok of ta) {
    if (tb.has(tok)) return true;
  }
  return false;
}

export interface SeriesCandidateBook {
  uri: string;
  workUri?: string;
  seriesId?: string;
  series?: string;
  title?: string;
  authors?: string[];
}

export interface MatchedExistingSeries {
  seriesId?: string;
  series: string;
  volumeCount: number;
  matchReason: 'work_uri' | 'work_title_author' | 'series_core_key';
}

export function findBestMatchingSeries(params: {
  candidateSeries?: string;
  candidateTitle?: string;
  candidateAuthors?: string[];
  candidateWorkUri?: string;
  existingBooks: SeriesCandidateBook[];
}): MatchedExistingSeries | null {
  const booksWithSeries = params.existingBooks.filter((b) => Boolean(b.series?.trim() || b.seriesId?.trim()));
  if (booksWithSeries.length === 0) return null;

  const countVolumesInSeries = (seriesId?: string, seriesName?: string): number => {
    const targetNameKey = seriesName ? normalizeTextKey(seriesName) : '';
    return booksWithSeries.filter(
      (b) => (seriesId && b.seriesId === seriesId) || (targetNameKey && normalizeTextKey(b.series || '') === targetNameKey)
    ).length;
  };

  // Étage 1A : Correspondance directe par workUri
  if (params.candidateWorkUri) {
    const byWork = booksWithSeries.find(
      (b) => b.workUri && b.workUri === params.candidateWorkUri && b.series?.trim()
    );
    if (byWork?.series) {
      return {
        seriesId: byWork.seriesId,
        series: byWork.series,
        volumeCount: countVolumesInSeries(byWork.seriesId, byWork.series),
        matchReason: 'work_uri'
      };
    }
  }

  // Étage 1B : Correspondance par Titre d'œuvre normalisé + Auteur
  const normCandTitle = params.candidateTitle ? normalizeTextKey(params.candidateTitle) : '';
  if (normCandTitle.length >= 3) {
    const byTitle = booksWithSeries.find((b) => {
      if (!b.series?.trim() || !b.title) return false;
      const bt = normalizeTextKey(b.title);
      if (bt !== normCandTitle) return false;
      return hasAuthorOverlap(params.candidateAuthors, b.authors);
    });
    if (byTitle?.series) {
      return {
        seriesId: byTitle.seriesId,
        series: byTitle.series,
        volumeCount: countVolumesInSeries(byTitle.seriesId, byTitle.series),
        matchReason: 'work_title_author'
      };
    }
  }

  // Étage 2 & 3 : Correspondance par noyau sémantique de série + auteur, en privilégiant la série la plus complète
  if (!params.candidateSeries?.trim()) return null;
  const { coreKey: candCoreKey } = stripEditorialCollectionSuffixes(params.candidateSeries);
  if (!candCoreKey) return null;

  const groups = new Map<
    string,
    { seriesId?: string; series: string; count: number; authors: string[] }
  >();

  for (const b of booksWithSeries) {
    if (!b.series?.trim()) continue;
    const { coreKey: bCore } = stripEditorialCollectionSuffixes(b.series);
    if (!bCore || bCore !== candCoreKey) continue;

    const gKey = b.seriesId || `name:${normalizeTextKey(b.series)}`;
    const existing = groups.get(gKey);
    if (existing) {
      existing.count++;
      if (b.authors?.length) existing.authors.push(...b.authors);
    } else {
      groups.set(gKey, {
        seriesId: b.seriesId,
        series: b.series,
        count: 1,
        authors: [...(b.authors || [])]
      });
    }
  }

  const compatible = Array.from(groups.values())
    .filter((g) => hasAuthorOverlap(params.candidateAuthors, g.authors))
    .sort((a, b) => {
      const aReal = a.seriesId && !a.seriesId.startsWith('local:') ? 1 : 0;
      const bReal = b.seriesId && !b.seriesId.startsWith('local:') ? 1 : 0;
      if (b.count !== a.count) return b.count - a.count;
      return bReal - aReal;
    });

  if (compatible.length === 0) return null;
  const best = compatible[0];
  return {
    seriesId: best.seriesId,
    series: best.series,
    volumeCount: best.count,
    matchReason: 'series_core_key'
  };
}
