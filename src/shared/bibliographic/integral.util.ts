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
    if (Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start && end - start <= 40) {
      for (let n = start; n <= end; n++) {
        result.add(String(n));
      }
      remaining = remaining.replace(match[0], ' ');
    }
  }

  for (const token of remaining.split(/[,;/\s]+/)) {
    const norm = normalizeSeriesNumber(token);
    if (norm && /^\d+(?:\.\d+)?$/.test(norm)) {
      result.add(norm);
    }
  }

  return Array.from(result).sort((a, b) => parseFloat(a) - parseFloat(b));
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
