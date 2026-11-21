// src/core/utils/series-matcher.util.ts
// Rapprochement orienté Œuvre (Work-first) pour éviter la création de séries doublons
// causée par les noms de collections éditoriales (ex: "Astérix - La Grande Collection" vs "Une aventure d'Astérix").

import { normalizeTextKey } from '../resolvers/bnf.resolver';

const EDITORIAL_COLLECTION_MARKERS = [
  'la grande collection',
  'grande collection',
  'la collection',
  'collection',
  'serie classique',
  'série classique',
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
  'livre de poche',
  'presente'
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
  'albums de ',
  'album de ',
  'albums d ',
  'album d ',
  'la collection ',
  'collection ',
  'les archives ',
  'la saga ',
  'saga '
];

const PAPERBACK_AND_PUBLISHER_COLLECTION_RE =
  /^(?:(?:la\s+)?collection\s+|editions?\s+|éditions?\s+)?(?:folio(?:\s+bd|\s+cadets|\s+junior|\s+sf|\s+policier)?|livre\s+de\s+poche|le\s+livre\s+de\s+poche|pocket(?:\s+bd)?|j['’]?\s*ai\s+lu|10\/18|10\s*18|points|babel|flammarion|gallimard(?:\s+jeunesse)?|dupuis|dargaud|le\s+lombard|gl[ée]nat|delcourt|soleil|casterman|hachette|rombaldi|france\s+loisirs|aire\s+libre|long\s+courrier|sign[ée]|rep[ée]rages|troisi[èe]me\s+vague|poisson\s+pilote)$/i;

/**
 * Détecte les noms de collections éditoriales génériques (ex: "Folio", "Collection Folio", "Pocket")
 * qui ne doivent jamais être élues en tant que Série narrative ni fournir leur n° de collection comme n° de tome.
 */
export function isEditorialPaperbackCollectionName(raw?: string): boolean {
  const cleaned = (raw || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return false;
  if (PAPERBACK_AND_PUBLISHER_COLLECTION_RE.test(cleaned)) return true;
  const norm = normalizeTextKey(cleaned);
  return PAPERBACK_AND_PUBLISHER_COLLECTION_RE.test(norm);
}

const SERIES_STOP_WORDS = new Set([
  'et',
  'de',
  'du',
  'des',
  'la',
  'le',
  'les',
  'un',
  'une',
  'l',
  'd',
  'the',
  'of',
  'and'
]);

function normalizeWithAmpersand(raw: string): string {
  return normalizeTextKey((raw || '').replace(/&/g, ' et '));
}

export function stripEditorialCollectionSuffixes(rawSeries: string): {
  cleanDisplay: string;
  coreKey: string;
  tokens: string[];
} {
  let display = (rawSeries || '').replace(/\s+/g, ' ').trim();
  if (!display) return { cleanDisplay: '', coreKey: '', tokens: [] };

  // Retirer un préfixe éditorial explicite ("Collection les Schtroumpfs", "La collection ...")
  const strippedLeadingDisplay = display
    .replace(/^(?:la\s+)?collection\s+(?=.{3,})/i, '')
    .trim();
  if (strippedLeadingDisplay.length >= 3) {
    display = strippedLeadingDisplay;
  }

  // Retirer les segments après "-", ":", "," ou "(...)" contenant un marqueur de collection éditoriale
  const normFull = normalizeWithAmpersand(display);
  for (const marker of EDITORIAL_COLLECTION_MARKERS) {
    if (normFull.includes(marker)) {
      const splitDash = display.split(/\s*[-–—:]\s+|,\s+/);
      if (splitDash.length > 1 && normalizeWithAmpersand(splitDash[splitDash.length - 1]).includes(marker)) {
        display = splitDash.slice(0, -1).join(' - ').trim();
      }
      display = display.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  let normalized = normalizeWithAmpersand(display);
  // Retirer les préfixes numériques génériques de séries (ex: "60 gags de Boule et Bill")
  normalized = normalized.replace(/^\d+\s+gags\s+(?:de|d)\s+/i, '').trim();
  // Alias BnF historique connu : "Les aventures de Tintin reporter" -> "Tintin"
  normalized = normalized.replace(/\btintin\s+reporter\b/i, 'tintin').trim();

  for (const prefix of SERIES_LEADING_PREFIXES) {
    if (normalized.startsWith(prefix) && normalized.slice(prefix.length).trim().length >= 3) {
      normalized = normalized.slice(prefix.length).trim();
      break;
    }
  }
  for (const marker of EDITORIAL_COLLECTION_MARKERS) {
    if (normalized.endsWith(` ${marker}`)) {
      normalized = normalized.slice(0, -(marker.length + 1)).trim();
    }
  }

  // Signature lexicale : supprimer les mots de liaison ("et", "de", "la"...) pour unifier "&" et "et"
  const rawTokens = normalized.split(' ').filter(Boolean);
  const meaningfulTokens = rawTokens.filter((t) => !SERIES_STOP_WORDS.has(t));
  const tokens = meaningfulTokens.length > 0 ? meaningfulTokens : rawTokens;
  const coreKey = tokens.join(' ').trim();

  return { cleanDisplay: display || rawSeries.trim(), coreKey, tokens };
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
  isbn13?: string;
  isbn10?: string;
  knownIsbns?: string[];
  seriesId?: string;
  series?: string;
  seriesNumber?: string;
  title?: string;
  authors?: string[];
  ownershipStatus?: 'owned' | 'wish' | 'none';
}

export interface MatchedExistingSeries {
  seriesId?: string;
  series: string;
  volumeCount: number;
  matchReason: 'work_uri' | 'work_title_author' | 'series_core_key';
}

export interface MatchedOwnedWork {
  book: SeriesCandidateBook;
  matchReason: 'isbn' | 'known_isbn' | 'work_uri' | 'title_author' | 'series_volume';
}

function hasSeriesAuthorContinuity(
  candidateAuthors: string[] | undefined,
  groupAuthors: string[],
  seriesTokens: string[]
): boolean {
  if (hasAuthorOverlap(candidateAuthors, groupAuthors)) return true;

  // Vérifier les mentions "d'après <Auteur>" fréquentes dans les reprises de séries BD
  const groupTokens = extractAuthorTokens(groupAuthors);
  const candRaw = normalizeTextKey((candidateAuthors || []).join(' '));
  const afterMatch = candRaw.match(/(?:d\s*apres|apres|hommage a|based on)\s+([a-z0-9\s]+)/);
  if (afterMatch) {
    for (const tok of afterMatch[1].split(' ')) {
      if (tok.length >= 3 && groupTokens.has(tok)) return true;
    }
  }

  // Si la signature de série comporte >= 2 mots significatifs (>= 8 caractères au total),
  // le risque d'homonymie est négligeable même lors d'un changement complet d'auteurs (ex: "boule bill", "spirou fantasio").
  if (seriesTokens.length >= 2 && seriesTokens.join('').length >= 8) {
    return true;
  }

  return false;
}

function normalizeIsbnToken(raw?: string): string {
  return (raw || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeVolNum(raw?: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (/^(?:int\.?|int[ée]grale)/i.test(trimmed)) return `int:${trimmed.toLowerCase()}`;
  const hsMatch = /^hs\s*(\d+)?$/i.exec(trimmed);
  if (hsMatch) return `hs:${hsMatch[1] ? parseInt(hsMatch[1], 10) : 0}`;
  const clean = trimmed.replace(/^(?:tome|t\.|vol\.?|n°|no\.?)\s*/i, '').trim();
  const numMatch = /^0*(\d+(?:\.\d+)?)$/.exec(clean);
  if (numMatch) return numMatch[1];
  return trimmed.toLowerCase();
}

/**
 * Détection orientée Œuvre : vérifie si un album (scanné par code-barres ou photo IA)
 * correspond déjà à une œuvre présente dans la collection/wishlist, même sous une autre édition.
 */
export function findMatchingOwnedWork(params: {
  candidateIsbns?: string[];
  candidateWorkUri?: string;
  candidateTitle?: string;
  candidateAuthors?: string[];
  candidateSeries?: string;
  candidateSeriesNumber?: string;
  existingBooks: SeriesCandidateBook[];
  targetStatuses?: Array<'owned' | 'wish'>;
}): MatchedOwnedWork | null {
  const statuses = new Set(params.targetStatuses || ['owned']);
  const pool = params.existingBooks.filter((b) => b.ownershipStatus && statuses.has(b.ownershipStatus));
  if (pool.length === 0) return null;

  const candIsbns = new Set(
    (params.candidateIsbns || []).map(normalizeIsbnToken).filter((x) => x.length >= 10)
  );

  // 1. Correspondance directe par ISBN principal ou URI isbn:...
  if (candIsbns.size > 0) {
    for (const b of pool) {
      const direct = [
        b.isbn13,
        b.isbn10,
        b.uri?.startsWith('isbn:') ? b.uri.slice(5) : undefined
      ]
        .map(normalizeIsbnToken)
        .filter(Boolean);
      if (direct.some((x) => candIsbns.has(x))) {
        return { book: b, matchReason: 'isbn' };
      }
      const known = (b.knownIsbns || []).map(normalizeIsbnToken).filter(Boolean);
      if (known.some((x) => candIsbns.has(x))) {
        return { book: b, matchReason: 'known_isbn' };
      }
    }
  }

  // 2. Correspondance par workUri
  if (params.candidateWorkUri) {
    const byWork = pool.find((b) => b.workUri && b.workUri === params.candidateWorkUri);
    if (byWork) return { book: byWork, matchReason: 'work_uri' };
  }

  // 3. Correspondance par titre d'œuvre normalisé + auteur (uniquement si pas de conflit de numéro de tome)
  const normTitle = params.candidateTitle ? normalizeTextKey(params.candidateTitle) : '';
  const candVolNorm = normalizeVolNum(params.candidateSeriesNumber);
  if (normTitle.length >= 3) {
    const byTitle = pool.find((b) => {
      if (!b.title || normalizeTextKey(b.title) !== normTitle) return false;
      if (!hasAuthorOverlap(params.candidateAuthors, b.authors)) return false;
      const bVolNorm = normalizeVolNum(b.seriesNumber);
      // Ne jamais confondre Culottées T.1 et Culottées T.2 (ou un tome numéroté et une intégrale)
      if (candVolNorm && bVolNorm && candVolNorm !== bVolNorm) return false;
      if ((candVolNorm && !bVolNorm) || (!candVolNorm && bVolNorm)) {
        const bSeriesNorm = b.series ? normalizeTextKey(b.series) : '';
        const candSeriesNorm = params.candidateSeries ? normalizeTextKey(params.candidateSeries) : '';
        if (normTitle === bSeriesNorm || normTitle === candSeriesNorm) return false;
      }
      return true;
    });
    if (byTitle) return { book: byTitle, matchReason: 'title_author' };
  }

  // 4. Correspondance par (signature de série + numéro de tome)
  const normVol = normalizeVolNum(params.candidateSeriesNumber);
  if (params.candidateSeries?.trim() && normVol) {
    const { coreKey: candCore, tokens: candTokens } = stripEditorialCollectionSuffixes(params.candidateSeries);
    if (candCore) {
      const byVol = pool.find((b) => {
        if (!b.series?.trim() || !b.seriesNumber) return false;
        const { coreKey: bCore } = stripEditorialCollectionSuffixes(b.series);
        if (bCore !== candCore) return false;
        if (normalizeVolNum(b.seriesNumber) !== normVol) return false;
        return hasSeriesAuthorContinuity(params.candidateAuthors, b.authors || [], candTokens);
      });
      if (byVol) return { book: byVol, matchReason: 'series_volume' };
    }
  }

  return null;
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

  // Étage 2 & 3 : Correspondance par noyau sémantique de série + continuité d'auteur, en privilégiant la série la plus complète
  if (!params.candidateSeries?.trim()) return null;
  const { coreKey: candCoreKey, tokens: candTokens } = stripEditorialCollectionSuffixes(params.candidateSeries);
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
    .filter((g) => hasSeriesAuthorContinuity(params.candidateAuthors, g.authors, candTokens))
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
