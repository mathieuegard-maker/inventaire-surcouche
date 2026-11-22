// src/core/bibliographic/integral.util.ts
// Primitives pures partagées (Front + Back) pour les intégrales, plages de tomes inclus et détection de couverture.

import { normalizeSeriesNumber, normalizeTextKey } from '../resolvers/bnf.resolver';
import type { HumanizedBook, IntegralMetadata, ParentIntegralRef } from '../types';

/**
 * Parse une saisie libre ("1 à 3", "1-3, 5", "T.4, T.5") ou un tableau de numéros
 * en une liste triée et dédupliquée de numéros de tomes normalisés.
 */
export function parseIncludedVolumeNumbers(raw?: string | string[] | null): string[] {
  if (!raw) return [];
  const rawStr = Array.isArray(raw) ? raw.join(', ') : String(raw);
  const cleaned = rawStr.trim();
  if (!cleaned) return [];

  const result = new Set<string>();

  // 1. Plages explicites : "1-3", "1 à 3", "T.1 - T.4", "1..3"
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

  // 2. Numéros individuels restants
  for (const token of remaining.split(/[,;/\s]+/)) {
    const norm = normalizeSeriesNumber(token);
    if (norm && /^\d+(?:\.\d+)?$/.test(norm)) {
      result.add(norm);
    }
  }

  return Array.from(result).sort((a, b) => parseFloat(a) - parseFloat(b));
}

/**
 * Formate une liste de tomes inclus en chaîne compacte ("1-3" si contigus, sinon "1, 3, 5").
 */
export function formatIncludedVolumeNumbers(vols?: string[] | null): string {
  const parsed = parseIncludedVolumeNumbers(vols || []);
  if (parsed.length === 0) return '';
  if (parsed.length === 1) return parsed[0];

  const nums = parsed.map((v) => Number(v));
  const isContiguousIntegers =
    nums.every((n) => Number.isInteger(n)) &&
    nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);

  if (isContiguousIntegers) {
    return `${nums[0]}-${nums[nums.length - 1]}`;
  }
  return parsed.join(', ');
}

/**
 * Produit l'étiquette courte affichée sur les couvertures et cartes ("Int. T.1-3" ou "Intégrale").
 */
export function formatIntegralRangeLabel(vols?: string[] | null, fallbackLabel?: string): string {
  const formatted = formatIncludedVolumeNumbers(vols);
  if (formatted) return `Int. T.${formatted}`;
  if (fallbackLabel && /int/i.test(fallbackLabel)) return fallbackLabel;
  return 'Intégrale';
}

/**
 * Construit un objet IntegralMetadata propre à partir d'une saisie de tomes inclus.
 */
export function buildIntegralMetadata(
  includedVolumeNumbers: string[] | string | undefined,
  existing?: Partial<IntegralMetadata>
): IntegralMetadata {
  const parsed = parseIncludedVolumeNumbers(includedVolumeNumbers);
  return {
    includedVolumeNumbers: parsed,
    includedWorkIds: existing?.includedWorkIds ? [...existing.includedWorkIds] : [],
    includedIsbns: existing?.includedIsbns ? [...existing.includedIsbns] : []
  };
}

/**
 * Détermine si un tome unitaire est couvert par au moins une intégrale possédée du foyer.
 * Vérifie d'abord les liens explicites (`parentIntegrals`), puis les correspondances de série + numéro / ISBN.
 */
export function findCoveringOwnedIntegral(
  book: HumanizedBook,
  ownedIntegrals: HumanizedBook[]
): ParentIntegralRef | null {
  if (!book || book.isIntegral || ownedIntegrals.length === 0) return null;

  const ownedByBookId = new Map<string, HumanizedBook>();
  for (const ob of ownedIntegrals) {
    if (ob.bookId) ownedByBookId.set(ob.bookId, ob);
    ownedByBookId.set(ob.uri, ob);
  }

  // 1. Lien parentIntegrals explicite
  if (Array.isArray(book.parentIntegrals)) {
    for (const ref of book.parentIntegrals) {
      const match = ownedByBookId.get(ref.integralBookId);
      if (match) {
        return {
          integralBookId: match.bookId || match.uri,
          title: match.title || ref.title,
          isbn13: match.isbn13 || ref.isbn13 || ''
        };
      }
    }
  }

  // 2. Couverture par intégrale possédée de la même série (numéro de tome, workId ou ISBN)
  const bookVol = book.seriesNumber ? normalizeSeriesNumber(book.seriesNumber) : '';
  const bookSeriesKey = normalizeTextKey(book.series || '');

  for (const integral of ownedIntegrals) {
    if (integral.uri === book.uri) continue;
    const meta = integral.integralMetadata;
    if (!meta) continue;

    if (book.bookId && meta.includedWorkIds?.includes(book.bookId)) {
      return {
        integralBookId: integral.bookId || integral.uri,
        title: integral.title,
        isbn13: integral.isbn13 || ''
      };
    }

    if (book.isbn13 && meta.includedIsbns?.includes(book.isbn13)) {
      return {
        integralBookId: integral.bookId || integral.uri,
        title: integral.title,
        isbn13: integral.isbn13 || ''
      };
    }

    if (bookVol && meta.includedVolumeNumbers?.length) {
      const sameSeriesId = Boolean(book.seriesId && integral.seriesId && book.seriesId === integral.seriesId);
      const sameSeriesName = Boolean(
        bookSeriesKey && integral.series && normalizeTextKey(integral.series) === bookSeriesKey
      );
      if (sameSeriesId || sameSeriesName) {
        const coveredNorms = meta.includedVolumeNumbers.map((v) => normalizeSeriesNumber(String(v)));
        if (coveredNorms.includes(bookVol)) {
          return {
            integralBookId: integral.bookId || integral.uri,
            title: integral.title,
            isbn13: integral.isbn13 || ''
          };
        }
      }
    }
  }

  return null;
}

/**
 * Annote une liste de livres avec `ownedViaIntegral` lorsqu'un tome unitaire
 * est couvert par une intégrale possédée du foyer (sans dupliquer la possession physique).
 */
export function annotateIntegralCoverage(
  books: HumanizedBook[],
  allCachedBooks: HumanizedBook[]
): HumanizedBook[] {
  const ownedIntegrals = allCachedBooks.filter(
    (b) => b.isIntegral && b.ownershipStatus === 'owned'
  );
  if (ownedIntegrals.length === 0) {
    return books.map((b) => (b.ownedViaIntegral ? { ...b, ownedViaIntegral: undefined } : b));
  }

  return books.map((book) => {
    if (book.isIntegral) {
      return book.ownedViaIntegral ? { ...book, ownedViaIntegral: undefined } : book;
    }
    const covering = findCoveringOwnedIntegral(book, ownedIntegrals);
    if (covering) {
      return { ...book, ownedViaIntegral: covering };
    }
    return book.ownedViaIntegral ? { ...book, ownedViaIntegral: undefined } : book;
  });
}
