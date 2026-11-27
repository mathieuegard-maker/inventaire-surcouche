// src/shared/bibliographic/list-filter.util.ts
// Moteur pur de filtrage composite multi-facettes partagé entre toutes les vues listes (Collection, Wishlist, Prêts, Séries, Auteur, Amis).

import type { BookView, ReadingStatus, SeriesView } from '../types/domain.types';
import { normalizeSeriesNumber, normalizeTextKey } from './text-normalize.util';

export type ListLoanFilter = 'all' | 'lent' | 'available';
export type ListReadingFilter = 'all' | ReadingStatus;
export type ListSeriesCompletionFilter = 'all' | 'complete' | 'incomplete';

export interface CompositeListFilters {
  query: string;
  genre: string;
  author: string;
  publisher: string;
  series: string;
  volumeNumber: string;
  readingStatus: ListReadingFilter;
  loanState: ListLoanFilter;
  integralOnly: boolean;
  seriesCompletion: ListSeriesCompletionFilter;
}

export function createEmptyListFilters(): CompositeListFilters {
  return {
    query: '',
    genre: '',
    author: '',
    publisher: '',
    series: '',
    volumeNumber: '',
    readingStatus: 'all',
    loanState: 'all',
    integralOnly: false,
    seriesCompletion: 'all'
  };
}

export function countActiveAdvancedFilters(filters: CompositeListFilters): number {
  let count = 0;
  if (filters.genre.trim()) count++;
  if (filters.author.trim()) count++;
  if (filters.publisher.trim()) count++;
  if (filters.series.trim()) count++;
  if (filters.volumeNumber.trim()) count++;
  if (filters.readingStatus !== 'all') count++;
  if (filters.loanState !== 'all') count++;
  if (filters.integralOnly) count++;
  if (filters.seriesCompletion !== 'all') count++;
  return count;
}

export interface ExtractedFilterFacets {
  genres: string[];
  authors: string[];
  publishers: string[];
  seriesNames: string[];
}

export function extractFilterFacets(
  books: readonly BookView[],
  preferredGenres: readonly string[] = []
): ExtractedFilterFacets {
  const genreSet = new Set<string>();
  const orderedGenres: string[] = [];
  for (const g of preferredGenres) {
    const clean = g.trim();
    if (clean && !genreSet.has(clean.toLowerCase())) {
      genreSet.add(clean.toLowerCase());
      orderedGenres.push(clean);
    }
  }

  const authorMap = new Map<string, string>();
  const publisherMap = new Map<string, string>();
  const seriesMap = new Map<string, string>();

  for (const b of books) {
    if (b.mainCategory && !genreSet.has(b.mainCategory.toLowerCase())) {
      genreSet.add(b.mainCategory.toLowerCase());
      orderedGenres.push(b.mainCategory);
    }
    for (const g of b.genres ?? []) {
      const clean = g.trim();
      if (clean && !genreSet.has(clean.toLowerCase())) {
        genreSet.add(clean.toLowerCase());
        orderedGenres.push(clean);
      }
    }
    for (const a of b.authors ?? []) {
      const key = normalizeTextKey(a);
      if (key && !authorMap.has(key)) authorMap.set(key, a.trim());
    }
    if (b.publisher?.trim()) {
      const key = normalizeTextKey(b.publisher);
      if (key && !publisherMap.has(key)) publisherMap.set(key, b.publisher.trim());
    }
    if (b.seriesName?.trim()) {
      const key = normalizeTextKey(b.seriesName);
      if (key && !seriesMap.has(key)) seriesMap.set(key, b.seriesName.trim());
    }
  }

  return {
    genres: orderedGenres,
    authors: Array.from(authorMap.values()).sort((a, b) => a.localeCompare(b, 'fr')),
    publishers: Array.from(publisherMap.values()).sort((a, b) => a.localeCompare(b, 'fr')),
    seriesNames: Array.from(seriesMap.values()).sort((a, b) => a.localeCompare(b, 'fr'))
  };
}

function bookMatchesGenre(book: BookView, genreFilter: string): boolean {
  const needle = normalizeTextKey(genreFilter);
  if (!needle) return true;
  if (normalizeTextKey(book.mainCategory) === needle) return true;
  return (book.genres ?? []).some((g) => normalizeTextKey(g) === needle);
}

export function applyBookListFilters(
  books: readonly BookView[],
  filters: CompositeListFilters
): BookView[] {
  const qNorm = normalizeTextKey(filters.query);
  const qRaw = filters.query.trim().toLowerCase();
  const authorNorm = normalizeTextKey(filters.author);
  const pubNorm = normalizeTextKey(filters.publisher);
  const seriesNorm = normalizeTextKey(filters.series);
  const volNorm = normalizeSeriesNumber(filters.volumeNumber);
  const volRaw = filters.volumeNumber.trim().toLowerCase();

  return books.filter((book) => {
    if (qNorm || qRaw) {
      const hay = normalizeTextKey(
        [
          book.title,
          book.seriesName ?? '',
          book.authors.join(' '),
          book.publisher ?? '',
          book.mainCategory,
          ...(book.genres ?? [])
        ].join(' ')
      );
      const isbnMatch = qRaw.length >= 4 && (book.knownIsbns ?? []).some((i) => i.toLowerCase().includes(qRaw));
      if (!hay.includes(qNorm) && !isbnMatch) return false;
    }

    if (filters.genre.trim() && !bookMatchesGenre(book, filters.genre)) {
      return false;
    }

    if (authorNorm) {
      const matched = (book.authors ?? []).some((a) => normalizeTextKey(a).includes(authorNorm));
      if (!matched) return false;
    }

    if (pubNorm) {
      if (!book.publisher || !normalizeTextKey(book.publisher).includes(pubNorm)) return false;
    }

    if (seriesNorm) {
      if (!book.seriesName || !normalizeTextKey(book.seriesName).includes(seriesNorm)) return false;
    }

    if (volNorm || volRaw) {
      const bookVolStr =
        book.volumeNumber !== null && book.volumeNumber !== undefined
          ? String(book.volumeNumber)
          : normalizeSeriesNumber(book.volumeLabel);
      const inIntegral = (book.includedVolumes ?? []).some(
        (v) => normalizeSeriesNumber(v) === volNorm || v.toLowerCase() === volRaw
      );
      const directMatch =
        (volNorm && bookVolStr === volNorm) ||
        (book.volumeLabel && book.volumeLabel.toLowerCase() === volRaw);
      if (!directMatch && !inIntegral) return false;
    }

    if (filters.readingStatus !== 'all') {
      const currentStatus: ReadingStatus = book.readingState?.status ?? 'none';
      if (currentStatus !== filters.readingStatus) return false;
    }

    if (filters.loanState === 'lent' && !book.activeLoan) return false;
    if (filters.loanState === 'available' && book.activeLoan) return false;

    if (filters.integralOnly && !book.isIntegral) return false;

    return true;
  });
}

export function applySeriesListFilters(
  seriesList: readonly SeriesView[],
  filters: CompositeListFilters,
  booksBySeriesId: ReadonlyMap<string, readonly BookView[]>
): SeriesView[] {
  const qNorm = normalizeTextKey(filters.query);
  const authorNorm = normalizeTextKey(filters.author);
  const pubNorm = normalizeTextKey(filters.publisher);
  const seriesNorm = normalizeTextKey(filters.series);

  return seriesList.filter((series) => {
    const relatedBooks = booksBySeriesId.get(series.id) ?? [];

    if (qNorm) {
      const hay = normalizeTextKey(
        [
          series.canonicalName,
          ...(series.aliases ?? []),
          ...(series.primaryAuthors ?? []),
          ...relatedBooks.flatMap((b) => [b.title, b.publisher ?? '', b.mainCategory, ...(b.genres ?? [])])
        ].join(' ')
      );
      if (!hay.includes(qNorm)) return false;
    }

    if (filters.genre.trim()) {
      const matched = relatedBooks.some((b) => bookMatchesGenre(b, filters.genre));
      if (!matched) return false;
    }

    if (authorNorm) {
      const authorPool = [
        ...(series.primaryAuthors ?? []),
        ...relatedBooks.flatMap((b) => b.authors ?? [])
      ];
      if (!authorPool.some((a) => normalizeTextKey(a).includes(authorNorm))) return false;
    }

    if (pubNorm) {
      if (!relatedBooks.some((b) => b.publisher && normalizeTextKey(b.publisher).includes(pubNorm))) {
        return false;
      }
    }

    if (seriesNorm) {
      const hay = normalizeTextKey(`${series.canonicalName} ${(series.aliases ?? []).join(' ')}`);
      if (!hay.includes(seriesNorm)) return false;
    }

    if (filters.seriesCompletion === 'complete') {
      if (series.knownVolumesCount <= 0 || series.ownedCount < series.knownVolumesCount) return false;
    } else if (filters.seriesCompletion === 'incomplete') {
      if (series.knownVolumesCount > 0 && series.ownedCount >= series.knownVolumesCount) return false;
    }

    return true;
  });
}
