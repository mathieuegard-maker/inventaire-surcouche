// src/shared/bibliographic/edition-lineage.util.ts
// Utilitaires purs (zéro import Vue/Node/SQL/réseau) pour identifier, comparer et harmoniser
// les lignées éditoriales (éditeur, collection, préfixe éditeur ISBN-13) au sein d'une série.

import { isbnUtil } from './isbn.util';
import { normalizeTextKey } from './text-normalize.util';

export interface EditionLineageInput {
  isbn13?: string | null;
  publisher?: string | null;
  collectionName?: string | null;
  publishYear?: string | null;
}

export interface EditionLineage {
  /** Clé canonique de lignée (la plus précise disponible : pub+col, pub, ou pfx ISBN) */
  key: string;
  /** Clé normalisée d'éditeur (ex. "pub:dargaud") */
  publisherKey: string | null;
  /** Clé normalisée d'éditeur + collection (ex. "pub:gallimard|col:folio sf") */
  collectionKey: string | null;
  /** Préfixe éditeur extrait de l'ISBN-13 selon les plages officielles GS1/AFNIL */
  isbnPrefix: string | null;
  /** Libellé lisible pour l'interface */
  label: string;
  publisher: string | null;
  collectionName: string | null;
}

export interface SeriesBookLineageCandidate {
  bookId: string;
  isOwned?: boolean;
  isIntegral?: boolean;
  defaultCoverKey?: string | null;
  editions: Array<{
    isbn13: string;
    publisher?: string | null;
    collectionName?: string | null;
    publishYear?: string | null;
    coverKey?: string | null;
  }>;
}

export interface DominantSeriesLineageResult {
  lineage: EditionLineage;
  coveredBookCount: number;
  totalCoveredBooksInSeries: number;
}

const PUBLISHER_NOISE_TOKENS = new Set([
  'ed',
  'eds',
  'editions',
  'edition',
  'editeur',
  'editeurs',
  'librairie',
  'maison',
  'groupe',
  'diffusion',
  'diff',
  'sas',
  'sarl',
  'sa',
  'eurl',
  'inc',
  'ltd',
  'llc',
  'france',
  'paris',
  'bruxelles'
]);

const COLLECTION_NOISE_PREFIX_RE = /^(?:collection|coll\.?|bibliotheque|serie|edition)\s+/i;

/**
 * Normalise un nom d'éditeur pour regrouper les variantes typographiques ("Éditions Dargaud", "Dargaud France", "DARGAUD").
 */
export function normalizePublisherKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Prend le premier éditeur si co-édition séparée par "/" ou ";" (ex. "Dargaud / Le Lombard")
  const primary = raw.split(/[;/|]/)[0]?.trim() ?? '';
  const norm = normalizeTextKey(primary);
  if (!norm) return null;

  const tokens = norm.split(' ').filter((tok) => tok.length > 0 && !PUBLISHER_NOISE_TOKENS.has(tok));
  const cleaned = (tokens.length > 0 ? tokens : norm.split(' ')).join(' ').trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Normalise un nom de collection éditoriale ("Coll. Folio SF" -> "folio sf").
 */
export function normalizeCollectionKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(COLLECTION_NOISE_PREFIX_RE, '').trim();
  const norm = normalizeTextKey(cleaned);
  return norm.length >= 2 ? norm : null;
}

/**
 * Extrait le préfixe éditeur officiel d'un ISBN-13 (norme GS1/ISBN Internationale).
 * Couvre avec précision les plages francophones `978-2` et `979-10`, et fournit un préfixe stable ailleurs.
 * Zéro nom d'éditeur codé en dur : uniquement les règles numériques officielles de découpage ISBN.
 */
export function extractIsbnPublisherPrefix(rawIsbn: string | null | undefined): string | null {
  const isbn13 = isbnUtil.normalizeToIsbn13(rawIsbn ?? '');
  if (!isbn13) return null;

  // Zone francophone 978-2-XXXX... (règles officielles Agence ISBN groupe 2)
  if (isbn13.startsWith('9782')) {
    const body = isbn13.slice(4); // 8 chiffres + clé
    const n2 = parseInt(body.slice(0, 2), 10);
    const n3 = parseInt(body.slice(0, 3), 10);
    const n4 = parseInt(body.slice(0, 4), 10);
    const n5 = parseInt(body.slice(0, 5), 10);
    const n6 = parseInt(body.slice(0, 6), 10);

    let regLen = 4;
    if (n2 >= 0 && n2 <= 19) regLen = 2;
    else if ((n3 >= 200 && n3 <= 349) || (n3 >= 400 && n3 <= 699)) regLen = 3;
    else if (n5 >= 35000 && n5 <= 39999) regLen = 5;
    else if (n4 >= 7000 && n4 <= 8399) regLen = 4;
    else if (n5 >= 84000 && n5 <= 89999) regLen = 5;
    else if (n6 >= 900000 && n6 <= 949999) regLen = 6;
    else regLen = 7;

    return isbn13.slice(0, 4 + regLen);
  }

  // Zone France 979-10-XXXX... (règles officielles AFNIL groupe 10)
  if (isbn13.startsWith('97910')) {
    const body = isbn13.slice(5);
    const n3 = parseInt(body.slice(0, 3), 10);
    const n4 = parseInt(body.slice(0, 4), 10);
    const n5 = parseInt(body.slice(0, 5), 10);
    const n6 = parseInt(body.slice(0, 6), 10);

    let regLen = 4;
    if (n3 >= 200 && n3 <= 399) regLen = 3;
    else if (n4 >= 4000 && n4 <= 6999) regLen = 4;
    else if (n5 >= 70000 && n5 <= 89999) regLen = 5;
    else if (n6 >= 900000 && n6 <= 999999) regLen = 6;
    else regLen = 4;

    return isbn13.slice(0, 5 + regLen);
  }

  // Autres zones linguistiques : préfixe générique stable 7 chiffres (ex. 9780140, 9781401)
  return isbn13.slice(0, 7);
}

/**
 * Formate un préfixe éditeur ISBN brut en libellé lisible (ex. "9782205" -> "978-2-205").
 */
export function formatIsbnPrefixLabel(prefix: string): string {
  if (prefix.startsWith('9782') && prefix.length > 4) {
    return `978-2-${prefix.slice(4)}`;
  }
  if (prefix.startsWith('97910') && prefix.length > 5) {
    return `979-10-${prefix.slice(5)}`;
  }
  if (prefix.length > 4) {
    return `${prefix.slice(0, 3)}-${prefix.slice(3, 4)}-${prefix.slice(4)}`;
  }
  return prefix;
}

/**
 * Construit la signature de lignée éditoriale d'une édition. Retourne `null` si aucun signal exploitable
 * (ex. photo uploadée manuellement ou URL externe sans éditeur ni ISBN).
 */
export function buildEditionLineage(input: EditionLineageInput): EditionLineage | null {
  const cleanPub = input.publisher?.trim() || null;
  const cleanCol = input.collectionName?.trim() || null;
  const pubNorm = normalizePublisherKey(cleanPub);
  const colNorm = normalizeCollectionKey(cleanCol);
  const isbnPrefix = extractIsbnPublisherPrefix(input.isbn13);

  if (!pubNorm && !colNorm && !isbnPrefix) {
    return null;
  }

  // Éviter la redondance quand le nom de collection est identique à l'éditeur (ex. "Pocket" / "Pocket")
  const distinctColNorm = colNorm && colNorm !== pubNorm ? colNorm : null;
  const distinctColLabel = distinctColNorm ? cleanCol : null;

  const publisherKey = pubNorm ? `pub:${pubNorm}` : null;
  const collectionKey =
    pubNorm && distinctColNorm
      ? `pub:${pubNorm}|col:${distinctColNorm}`
      : distinctColNorm
        ? `col:${distinctColNorm}`
        : null;

  const key = collectionKey ?? publisherKey ?? `pfx:${isbnPrefix}`;

  let label: string;
  if (cleanPub && distinctColLabel) {
    label = `${cleanPub} · ${distinctColLabel}`;
  } else if (cleanPub) {
    label = cleanPub;
  } else if (distinctColLabel) {
    label = distinctColLabel;
  } else {
    label = `Édition ${formatIsbnPrefixLabel(isbnPrefix!)}`;
  }

  return {
    key,
    publisherKey,
    collectionKey,
    isbnPrefix,
    label,
    publisher: cleanPub,
    collectionName: distinctColLabel
  };
}

/**
 * Calcule un score de correspondance entre une lignée cible et une édition candidate (0 = incompatible, 100 = exacte).
 * Règle métier : deux collections explicitement différentes chez un même éditeur (ex. "Folio" vs "Blanche" chez Gallimard)
 * sont considérées distinctes pour préserver la cohérence visuelle.
 */
export function matchEditionLineageScore(
  target: EditionLineage | null,
  candidate: EditionLineage | null
): number {
  if (!target || !candidate) return 0;

  // 1. Correspondance exacte éditeur + collection
  if (target.collectionKey && candidate.collectionKey) {
    if (target.collectionKey === candidate.collectionKey) return 100;
    // Collections différentes explicitement nommées -> incompatibles (même chez le même éditeur)
    return 0;
  }

  // 2. Même éditeur normalisé
  if (target.publisherKey && candidate.publisherKey) {
    if (target.publisherKey !== candidate.publisherKey) {
      // Deux éditeurs explicitement différents -> incompatibles (même si préfixe rarement partagé)
      return 0;
    }
    // Même éditeur : bonus si même préfixe ISBN (même branche / époque éditoriale)
    if (target.isbnPrefix && candidate.isbnPrefix && target.isbnPrefix === candidate.isbnPrefix) {
      // Si l'un précise une collection et l'autre non, légère décote par rapport à l'exact
      return target.collectionKey || candidate.collectionKey ? 80 : 90;
    }
    return target.collectionKey || candidate.collectionKey ? 70 : 78;
  }

  // 3. Repli préfixe ISBN-13 (très utile lorsque l'éditeur texte n'a pas encore été renseigné sur une édition sœur)
  if (target.isbnPrefix && candidate.isbnPrefix && target.isbnPrefix === candidate.isbnPrefix) {
    return 65;
  }

  return 0;
}

/**
 * Élit la lignée éditoriale dominante d'une série parmi toutes les éditions pourvues d'une couverture WebP.
 * Privilégie la lignée qui couvre le plus grand nombre de tomes distincts, avec tie-breaker en faveur
 * des tomes possédés par le foyer (édition scannée) et de la précision éditeur+collection.
 */
export function electDominantSeriesLineage(
  books: SeriesBookLineageCandidate[]
): DominantSeriesLineageResult | null {
  const unitary = books.filter((b) => !b.isIntegral);
  const pool = unitary.length > 0 ? unitary : books;

  // Construire les lignées disponibles par livre (uniquement les éditions ayant une couverture WebP réelle)
  const bookEditionLineages = new Map<
    string,
    { isOwned: boolean; entries: Array<{ coverKey: string; lineage: EditionLineage }> }
  >();

  let totalCoveredBooks = 0;

  for (const book of pool) {
    const entries: Array<{ coverKey: string; lineage: EditionLineage }> = [];
    for (const ed of book.editions) {
      if (!ed.coverKey) continue;
      const lineage = buildEditionLineage({
        isbn13: ed.isbn13,
        publisher: ed.publisher,
        collectionName: ed.collectionName,
        publishYear: ed.publishYear
      });
      if (lineage) {
        entries.push({ coverKey: ed.coverKey, lineage });
      }
    }
    if (entries.length > 0 || book.defaultCoverKey) {
      totalCoveredBooks++;
    }
    if (entries.length > 0) {
      bookEditionLineages.set(book.bookId, {
        isOwned: Boolean(book.isOwned),
        entries
      });
    }
  }

  if (bookEditionLineages.size < 2) {
    return null;
  }

  // Rassembler les lignées candidates distinctes (en dédupliquant par clé, en privilégiant la version la plus riche en libellé)
  const candidateMap = new Map<string, EditionLineage>();
  for (const { entries } of bookEditionLineages.values()) {
    for (const { lineage } of entries) {
      const existing = candidateMap.get(lineage.key);
      if (!existing || (!existing.publisher && lineage.publisher)) {
        candidateMap.set(lineage.key, lineage);
      }
      // Ajouter aussi la lignée au niveau éditeur seul si la clé porte une collection
      if (lineage.collectionKey && lineage.publisherKey && !candidateMap.has(lineage.publisherKey)) {
        const pubOnly = buildEditionLineage({
          publisher: lineage.publisher,
          isbn13: lineage.isbnPrefix ? undefined : null
        });
        if (pubOnly) {
          candidateMap.set(pubOnly.key, { ...pubOnly, isbnPrefix: lineage.isbnPrefix });
        }
      }
    }
  }

  let best: {
    lineage: EditionLineage;
    coveredCount: number;
    ownedCount: number;
    avgMatchScore: number;
    specificity: number;
  } | null = null;

  for (const candidate of candidateMap.values()) {
    let coveredCount = 0;
    let ownedCount = 0;
    let scoreSum = 0;

    for (const { isOwned, entries } of bookEditionLineages.values()) {
      let bestForBook = 0;
      for (const entry of entries) {
        const s = matchEditionLineageScore(candidate, entry.lineage);
        if (s > bestForBook) bestForBook = s;
      }
      if (bestForBook >= 60) {
        coveredCount++;
        if (isOwned) ownedCount++;
        scoreSum += bestForBook;
      }
    }

    if (coveredCount < 2) continue;

    const avgMatchScore = scoreSum / coveredCount;
    const specificity = candidate.collectionKey ? 3 : candidate.publisherKey ? 2 : 1;

    const isBetter =
      !best ||
      coveredCount > best.coveredCount ||
      (coveredCount === best.coveredCount && ownedCount > best.ownedCount) ||
      (coveredCount === best.coveredCount &&
        ownedCount === best.ownedCount &&
        specificity > best.specificity) ||
      (coveredCount === best.coveredCount &&
        ownedCount === best.ownedCount &&
        specificity === best.specificity &&
        avgMatchScore > best.avgMatchScore);

    if (isBetter) {
      best = { lineage: candidate, coveredCount, ownedCount, avgMatchScore, specificity };
    }
  }

  if (!best) return null;

  // Exiger une vraie majorité / cohérence minimale (>= 2 tomes et au moins 40 % des tomes pourvus d'une couverture)
  const coverageRatio = totalCoveredBooks > 0 ? best.coveredCount / totalCoveredBooks : 0;
  if (coverageRatio < 0.4 && best.coveredCount < 3) {
    return null;
  }

  return {
    lineage: best.lineage,
    coveredBookCount: best.coveredCount,
    totalCoveredBooksInSeries: totalCoveredBooks
  };
}

/**
 * Sélectionne parmi les éditions d'un livre celle qui correspond le mieux à une lignée éditoriale cible
 * et dispose d'une couverture WebP (`coverKey`).
 */
export function selectBestEditionForLineage<
  T extends {
    isbn13: string;
    publisher?: string | null;
    collectionName?: string | null;
    publishYear?: string | null;
    coverKey?: string | null;
  }
>(editions: T[], targetLineage: EditionLineage | null, requireCover = true): { edition: T; score: number } | null {
  if (!targetLineage || editions.length === 0) return null;

  let best: { edition: T; score: number } | null = null;
  for (const ed of editions) {
    if (requireCover && !ed.coverKey) continue;
    const edLineage = buildEditionLineage(ed);
    const score = matchEditionLineageScore(targetLineage, edLineage);
    if (score < 60) continue;

    if (!best || score > best.score) {
      best = { edition: ed, score };
    } else if (score === best.score) {
      // À score égal, préférer une édition pourvue d'une couverture, puis la plus récente
      const edHasCover = Boolean(ed.coverKey);
      const bestHasCover = Boolean(best.edition.coverKey);
      if (edHasCover && !bestHasCover) {
        best = { edition: ed, score };
      } else if (edHasCover === bestHasCover) {
        const yEd = parseInt((ed.publishYear ?? '').slice(0, 4), 10) || 0;
        const yBest = parseInt((best.edition.publishYear ?? '').slice(0, 4), 10) || 0;
        if (yEd > yBest) {
          best = { edition: ed, score };
        }
      }
    }
  }

  return best;
}
