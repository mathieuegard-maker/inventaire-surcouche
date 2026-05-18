// src/core/types.ts

export interface RegistryEntry {
  uri: string;
  addedAt: number;
}

export interface BaseBook {
  uri: string;
  workUri?: string;
  isbn13?: string;
  isbn10?: string;
  type: 'edition' | 'work' | 'unknown';
  title: string;
  subtitle?: string;
  originalTitle?: string;
  description?: string;
  coverUrl?: string;
  localCover?: string;
  language?: string;
  pageCount?: number;
  publishDate?: string;
  format?: string;
  updatedAt?: number; // AJOUT : Horodatage pour le système de péremption du cache (TTL)
}

export interface RawBook extends BaseBook {
  authorIds: string[];
  illustratorIds: string[];
  scriptwriterIds: string[];
  publisherId?: string;
  seriesId?: string;
  seriesNumber?: string;
  genreIds: string[];
  collectionId?: string;
}

export interface HumanizedBook extends BaseBook {
  authors: string[];
  illustrators: string[];
  scriptwriters: string[];
  publisher?: string;
  series?: string;
  seriesId?: string;
  seriesNumber?: string;
  genres: string[];
  collection?: string;
  ownershipStatus: 'owned' | 'wish' | 'none';
}

/**
 * Structure pour le carnet de prêt local
 */
export interface LoanRecord {
  uri: string;
  friendName: string;
  loanDate: number;
  itemId?: string; // AJOUT : Sauvegarde de l'ID physique pour fiabiliser la synchro
}

export interface InventoryItem {
  _id?: string;
  entity: string;
  status: 'owned' | 'wishlist' | 'loaned' | 'sold';
  state?: 'new' | 'good' | 'worn' | 'damaged';
  available?: boolean;
  lentTo?: string;
  dateAdded: string;
  personalNote?: string;
}

export interface OwnershipAnalysis {
  isEditionOwned: boolean;
  isWorkOwned: boolean;
  isWished: boolean;
  duplicateEdition?: HumanizedBook;
}

export interface SeriesContext {
  id?: string;
  name?: string;
  tomes: HumanizedBook[];
  isComplete: boolean;
  ownedCount: number;
}

export interface SearchResponse {
  mainBook: HumanizedBook;
  ownership: OwnershipAnalysis;
  series?: SeriesContext;
  loan: {
    isLent: boolean;
    details?: LoanRecord;
  };
  source: 'cache' | 'network';
}