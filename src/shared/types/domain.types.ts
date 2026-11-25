// src/shared/types/domain.types.ts
// Types métier unifiés V2 (couche partagée pure — zéro import Vue / Node / SQL / réseau).

export type ThemeId = 'editorial-light' | 'dark' | 'warm';
export type LocaleId = 'fr';

export type BookMainCategory =
  | 'BD'
  | 'Manga'
  | 'Comics'
  | 'Roman'
  | 'Jeunesse'
  | 'Essai'
  | 'Poésie / Théâtre'
  | 'Pratique'
  | 'Art / Beau livre'
  | 'Autre';

export type OwnershipStatus = 'none' | 'wish' | 'owned';
export type ReadingStatus = 'none' | 'to_read' | 'reading' | 'read' | 'abandoned';
export type LibraryMemberRole = 'owner' | 'member';
export type BookSourceOrigin = 'auto' | 'manual';

export type BackgroundJobType =
  | 'photo_ocr'
  | 'photo_retry_item'
  | 'photo_commit'
  | 'series_expand'
  | 'series_enrich_volumes'
  | 'book_enrich'
  | 'collection_import';
export type BackgroundJobStatus = 'pending' | 'running' | 'done' | 'error';

export type NotificationFrequency = 'off' | 'daily' | 'weekly' | 'monthly';
export type NotificationChannel = 'push' | 'email' | 'both';

export type AcquisitionChannel = 'barcode_simple' | 'barcode_burst' | 'manual_isbn' | 'text_search' | 'photo_ai' | 'import';

/**
 * Surcharges privées verrouillées par le Foyer (Couche 3 > Couche 2 > Couche 1).
 */
export interface LibraryBookOverrides {
  title?: string;
  authors?: string[];
  scriptwriters?: string[];
  illustrators?: string[];
  seriesId?: string | null;
  seriesName?: string | null;
  volumeNumber?: number | null;
  volumeLabel?: string | null;
  sortOrder?: number | null;
  isHorsSerie?: boolean;
  isIntegral?: boolean;
  includedVolumes?: string[];
  publisher?: string | null;
  publishYear?: string | null;
  pageCount?: number | null;
  mainCategory?: BookMainCategory;
  genres?: string[];
  coverKey?: string | null;
  hiddenSeriesIds?: string[];
  oneShotForced?: boolean;
}

export interface ParentIntegralRef {
  integralBookId: string;
  title: string;
  isbn13?: string;
}

export interface BookEditionSummary {
  isbn13: string;
  publisher?: string | null;
  collectionName?: string | null;
  publishYear?: string | null;
  pageCount?: number | null;
  coverKey?: string | null;
  coverUrl?: string | null;
  source?: string | null;
}

export interface ActiveLoanView {
  id: string;
  bookId: string;
  borrowerName: string;
  loanedAt: string;
  notes?: string | null;
}

export interface UserReadingStateView {
  status: ReadingStatus;
  rating: number;
  notes: string;
  updatedAt: string | null;
}

/**
 * Représentation fusionnée d'un livre servie à l'UI (Couche 3 > Couche 2 > Couche 1).
 */
export interface BookView {
  id: string;
  workCanonicalId: string;
  title: string;
  seriesId: string | null;
  seriesName: string | null;
  franchiseId: string | null;
  volumeNumber: number | null;
  volumeLabel: string | null;
  sortOrder: number | null;
  isHorsSerie: boolean;
  isIntegral: boolean;
  includedVolumes: string[];
  authors: string[];
  scriptwriters: string[];
  illustrators: string[];
  publisher: string | null;
  collectionName: string | null;
  publishYear: string | null;
  pageCount: number | null;
  description: string | null;
  language: string;
  mainCategory: BookMainCategory;
  genres: string[];
  coverKey: string | null;
  coverUrl: string | null;
  primaryIsbn13: string | null;
  knownIsbns: string[];
  editions: BookEditionSummary[];
  ownershipStatus: OwnershipStatus;
  wishedByName: string | null;
  ownedViaIntegral: ParentIntegralRef | null;
  activeLoan: ActiveLoanView | null;
  readingState: UserReadingStateView | null;
  hasUserOverrides: boolean;
  hiddenSeriesIds: string[];
  updatedAt: string;
}

export interface SeriesView {
  id: string;
  franchiseId: string | null;
  canonicalName: string;
  editionSignature: string | null;
  aliases: string[];
  primaryAuthors: string[];
  wikidataQid: string | null;
  isCompleteExpanded: boolean;
  knownVolumesCount: number;
  ownedCount: number;
  coverUrl: string | null;
  updatedAt: string;
}

export interface FranchiseView {
  id: string;
  canonicalName: string;
  wikidataQid: string | null;
  series: SeriesView[];
}

export interface BackgroundJobView {
  id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  progressDone: number;
  progressTotal: number;
  targetSeriesId?: string | null;
  errorMessage: string | null;
  result: unknown;
  createdAt: string;
  updatedAt: string;
}
