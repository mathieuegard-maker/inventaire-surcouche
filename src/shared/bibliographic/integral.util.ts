// src/shared/bibliographic/integral.util.ts
// Primitives pures partagées pour les intégrales, plages de tomes inclus et détection bidirectionnelle de couverture.

import { normalizeSeriesNumber, normalizeTextKey } from './text-normalize.util';
import type { BookView, ParentIntegralRef } from '../types/domain.types';

export function parseIncludedVolumeNumbers(raw?: string | string[] | null): string[] {
  if (!raw) return [];
  const rawStr = Array.isArray(raw) ? raw.join(', ') : String(raw);
  const cleaned = rawStr.trim();
  if (!cleaned) return [];

  const result = new Set<string>();
  const rangeRegex = /(\d+)\s*(?:-|–|—|\.\.|à|a|to)\s*(?:t\.?\s*)?(\d+)/gi;
  let match: RegExpExecArray | null;
  let remaining = cleaned;

  while ((match = rangeRegex.exec(cleaned)) !== null) {
    const start = parseInt(match[1], 10);
    const end = parseInt(match[2], 10);
    // Rejette les plages d'années de publication (ex. "1946-1948" sur Buck Danny Intégrale 1) et numéros aberrants
    if (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start > 0 &&
      end >= start &&
      end <= 300 &&
      end - start <= 40
    ) {
      for (let n = start; n <= end; n++) {
        result.add(String(n));
      }
      remaining = remaining.replace(match[0], ' ');
    } else if (start >= 1800 && end >= 1800) {
      // Efface aussi la plage d'années pour éviter qu'elle ne soit re-parsée token par token
      remaining = remaining.replace(match[0], ' ');
    }
  }

  for (const token of remaining.split(/[,;/\s]+/)) {
    const norm = normalizeSeriesNumber(token);
    if (norm && /^\d+(?:\.\d+)?$/.test(norm)) {
      const val = parseFloat(norm);
      if (val > 0 && val <= 300) {
        result.add(norm);
      }
    }
  }

  return Array.from(result).sort((a, b) => parseFloat(a) - parseFloat(b));
}

const EDITORIAL_VOLUME_CLAUSE_RE =
  /(?:r[ée]unit|contient|regroupe|rassemble|int[ée]grale\s+des?|coffret\s+(?:regroupant|contenant|des?))\s+[^.\n]{0,160}|\b(?:tomes?|t\.|vol\.?|volumes?|albums?|livres?)\s*\d{1,2}(?:\s*(?:[-–—à,&]|\bet\b)\s*(?:t\.?\s*|tome\s*)?\d{1,2})+/gi;

const WORD_COUNT_INTEGRAL_RE =
  /\b(?:r[ée]uni(?:t|ssant)|contient|contenant|regroup(?:e|ant)|rassembl(?:e|ant))\s+(?:les\s+)?(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|douze|\d{1,2})\s+(?:premiers?\s+)?(?:tomes?|albums?|volumes?)\b/i;

const FRENCH_SMALL_NUMBERS: Record<string, number> = {
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  douze: 12
};

/**
 * Extrait prudemment les numéros de tomes inclus depuis une note MARC (300$a / 327$a) ou un résumé éditorial
 * sans jamais capturer les nombres narratifs d'un synopsis.
 */
export function extractIncludedVolumesFromEditorialText(rawText?: string | null): string[] {
  if (!rawText) return [];
  const text = rawText.trim();
  if (!text) return [];

  const collected = new Set<string>();
  const clauses = text.match(EDITORIAL_VOLUME_CLAUSE_RE) ?? [];
  for (const clause of clauses) {
    // Exclure les mentions de cycle seul ("du cycle 1") sans plage ni liste
    const cleanedClause = clause.replace(/\bcycle\s+\d+\b/gi, ' ');
    for (const v of parseIncludedVolumeNumbers(cleanedClause)) {
      collected.add(v);
    }
  }

  // Note de dépouillement structurée (MARC 327$a / 300$a : "Réunit : 1, Titre A ; 2, Titre B ; 3, Titre C")
  if (collected.size < 2 && /\b(?:r[ée]unit|contient)\s*:/i.test(text)) {
    const afterColon = text.split(/:\s*/).slice(1).join(': ');
    const itemMatches = afterColon.match(/(?:^|[;•\n])\s*(?:t\.?\s*|tome\s*)?(\d{1,2})\s*[,.:–-]/gi) ?? [];
    for (const m of itemMatches) {
      const numMatch = m.match(/(\d{1,2})/);
      if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        if (n > 0 && n <= 150) collected.add(String(n));
      }
    }
  }

  // Mention textuelle explicite "Réunit les quatre tomes" / "Contient les 6 albums"
  if (collected.size < 2) {
    const wordMatch = WORD_COUNT_INTEGRAL_RE.exec(text);
    if (wordMatch) {
      const token = wordMatch[1].toLowerCase();
      const count = /^\d+$/.test(token) ? parseInt(token, 10) : (FRENCH_SMALL_NUMBERS[token] ?? 0);
      if (count >= 2 && count <= 20) {
        for (let n = 1; n <= count; n++) collected.add(String(n));
      }
    }
  }

  const sorted = Array.from(collected).sort((a, b) => parseFloat(a) - parseFloat(b));
  return sorted.length >= 2 ? sorted : [];
}

export function formatIncludedVolumeNumbers(vols?: string[] | null): string {
  const parsed = parseIncludedVolumeNumbers(vols || []);
  if (parsed.length === 0) return '';
  if (parsed.length === 1) return parsed[0];

  const nums = parsed.map((v) => Number(v));
  const isContiguousIntegers =
    nums.every((n) => Number.isInteger(n)) &&
    nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);

  return isContiguousIntegers ? `${nums[0]}-${nums[nums.length - 1]}` : parsed.join(', ');
}

export function formatIntegralRangeLabel(vols?: string[] | null, fallbackLabel?: string): string {
  const formatted = formatIncludedVolumeNumbers(vols);
  if (formatted) return `Int. T.${formatted}`;
  if (fallbackLabel && /int/i.test(fallbackLabel)) return fallbackLabel;
  return 'Intégrale';
}

export type IntegralCheckBook = Pick<
  BookView,
  | 'id'
  | 'title'
  | 'seriesId'
  | 'seriesName'
  | 'volumeNumber'
  | 'volumeLabel'
  | 'isIntegral'
  | 'includedVolumes'
  | 'ownershipStatus'
  | 'primaryIsbn13'
  | 'ownedViaIntegral'
>;

export function findCoveringOwnedIntegral(
  book: IntegralCheckBook,
  ownedIntegrals: IntegralCheckBook[]
): ParentIntegralRef | null {
  if (!book || book.isIntegral || ownedIntegrals.length === 0) return null;

  const bookVol = normalizeSeriesNumber(book.volumeNumber ?? book.volumeLabel);
  if (!bookVol) return null;
  const bookSeriesKey = normalizeTextKey(book.seriesName || '');

  for (const integral of ownedIntegrals) {
    if (integral.id === book.id || !integral.includedVolumes?.length) continue;

    const sameSeriesId = Boolean(book.seriesId && integral.seriesId && book.seriesId === integral.seriesId);
    const sameSeriesName = Boolean(
      bookSeriesKey && integral.seriesName && normalizeTextKey(integral.seriesName) === bookSeriesKey
    );

    if (sameSeriesId || sameSeriesName) {
      const covered = integral.includedVolumes.map((v) => normalizeSeriesNumber(v));
      if (covered.includes(bookVol)) {
        return {
          integralBookId: integral.id,
          title: integral.title,
          isbn13: integral.primaryIsbn13 || undefined
        };
      }
    }
  }
  return null;
}

export function annotateIntegralCoverage<T extends IntegralCheckBook>(
  books: T[],
  allLibraryBooks: IntegralCheckBook[]
): T[] {
  const ownedIntegrals = allLibraryBooks.filter((b) => b.isIntegral && b.ownershipStatus === 'owned');
  if (ownedIntegrals.length === 0) {
    return books.map((b) => (b.ownedViaIntegral ? { ...b, ownedViaIntegral: null } : b));
  }

  return books.map((book) => {
    if (book.isIntegral) {
      return book.ownedViaIntegral ? { ...book, ownedViaIntegral: null } : book;
    }
    const covering = findCoveringOwnedIntegral(book, ownedIntegrals);
    return { ...book, ownedViaIntegral: covering };
  });
}
