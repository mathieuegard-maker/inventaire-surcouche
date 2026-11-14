// src/core/domain/v2.types.ts
// Source unique de vérité (DRY) partagée entre le Frontend (Dexie), l'API (Workers/Node) et la Base de données (D1/SQLite)

export type BookMainCategory =
  | 'BD'
  | 'Manga'
  | 'Comics'
  | 'Roman'
  | 'Essai'
  | 'Jeunesse'
  | 'Pratique'
  | 'Poésie / Théâtre'
  | 'Art / Beau livre'
  | 'Autre';

export type SeriesStatus = 'ongoing' | 'completed' | 'abandoned' | 'oneshot';

export type WorkType = 'standard' | 'hors_serie' | 'integrale' | 'spinoff' | 'coffret';

export type AuthorRole = 'author' | 'scenarist' | 'illustrator' | 'colorist' | 'translator';

export interface BookAuthor {
  name: string;
  role: AuthorRole;
}

export type OwnershipStatus = 'owned' | 'wishlist';

export type ReadingStatusType = 'unread' | 'reading' | 'read' | 'abandoned';

export type LibraryMemberRole = 'owner' | 'editor' | 'contributor' | 'viewer';

export type ShareTokenType =
  | 'invite_member'
  | 'public_collection_readonly'
  | 'public_wishlist_gifts';

// --- ZONE 1 : Catalogue commun dédupliqué ---

export interface CatalogSeries {
  id: string;
  title: string;
  normalizedTitle: string;
  mainCategory: BookMainCategory;
  subgenres: string[];
  status: SeriesStatus;
  knownVolumesCount: number;
  primaryAuthors: BookAuthor[];
  bnfArk?: string;
  wikidataQid?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogWork {
  id: string;
  seriesId: string | null; // null pour un roman ou essai unitaire
  title: string;
  normalizedTitle: string;
  workType: WorkType;
  volumeLabel: string | null; // ex: "1", "HS 1", "0", "Intégrale 1-3"
  sortOrder: number; // ex: 1, 1.5 (HS intercalé), 1000
  containsWorkIds: string[]; // Pour une intégrale : IDs des tomes inclus
  mainCategory: BookMainCategory;
  subgenres: string[];
  deweyCode?: string;
  rameauTags: string[];
  authors: BookAuthor[];
  summary?: string;
  defaultCoverUrl?: string;
  bnfWorkArk?: string;
  wikidataQid?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CatalogEdition {
  id: string;
  workId: string;
  isbn13?: string;
  isbn10?: string;
  title: string;
  publisher?: string;
  collectionName?: string;
  publishedDate?: string;
  pageCount?: number;
  formatBinding?: string;
  coverR2Key?: string;
  coverExternalUrl?: string;
  sources: string[];
  createdAt: string;
  updatedAt: string;
}

// --- ZONE 2 : Espaces privés & Foyers ---

export interface Library {
  id: string;
  name: string;
  ownerUserId: string;
  role?: LibraryMemberRole;
  createdAt: string;
  updatedAt: string;
}

export interface LibraryItem {
  id: string;
  libraryId: string;
  workId: string;
  editionId: string | null;
  ownershipStatus: OwnershipStatus;
  location?: string;
  condition?: string;
  acquiredAt?: string;
  giftReservedBy?: string;
  customOverrides: Partial<{
    title: string;
    volumeLabel: string;
    sortOrder: number;
    coverUrl: string;
    mainCategory: BookMainCategory;
    subgenres: string[];
  }>;
  isLocallyEdited: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserReadingStatus {
  id: string;
  libraryId: string;
  userId: string;
  workId: string;
  status: ReadingStatusType;
  rating?: number;
  personalNotes?: string;
  updatedAt: string;
}

export interface BookLoan {
  id: string;
  libraryId: string;
  libraryItemId: string;
  borrowerName: string;
  loanedAt: string;
  dueDate?: string;
  returnedAt?: string | null;
  notes?: string;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

// --- Résultat instantané pour le Mode Vérif Magasin (< 1 s) ---

export type StoreCheckVerdict =
  | 'OWNED_EXACT_EDITION'
  | 'OWNED_OTHER_EDITION'
  | 'OWNED_VIA_INTEGRALE'
  | 'IN_WISHLIST'
  | 'NOT_OWNED_SERIES_STARTED'
  | 'NOT_OWNED_NEW';

export interface StoreCheckResult {
  verdict: StoreCheckVerdict;
  scannedIsbn: string;
  edition?: CatalogEdition;
  work?: CatalogWork;
  series?: CatalogSeries;
  matchedItem?: LibraryItem;
  activeLoan?: BookLoan;
  missingSeriesVolumes?: Array<{
    workId: string;
    volumeLabel: string | null;
    title: string;
  }>;
}

// --- Payload de Synchronisation Différentielle (Delta Sync) ---

export interface SyncDeltaRequest {
  libraryId: string;
  lastSyncedAt: string | null; // ISO timestamp ou null pour 1ère synchro complète
  pushedItems: LibraryItem[];
  pushedLoans: BookLoan[];
  pushedReadingStatuses: UserReadingStatus[];
}

export interface SyncDeltaResponse {
  serverTimestamp: string;
  items: LibraryItem[];
  loans: BookLoan[];
  readingStatuses: UserReadingStatus[];
  works: CatalogWork[];
  editions: CatalogEdition[];
  series: CatalogSeries[];
}
