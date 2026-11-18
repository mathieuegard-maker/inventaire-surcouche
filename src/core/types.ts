// src/core/types.ts

export interface RegistryEntry {
  uri: string;
  addedAt: number;
  itemId?: string;
}

export interface ParentIntegralRef {
  integralBookId: string;
  title: string;
  isbn13: string;
}

export interface IntegralMetadata {
  includedVolumeNumbers: string[];
  includedWorkIds: string[];
  includedIsbns: string[];
}

export interface EditionCatalogEntry {
  isbn13: string;
  publisher?: string;
  publicationYear?: string;
  coverUrl?: string;
}

export interface BaseBook {
  uri: string;
  bookId?: string;
  workUri?: string;
  isbn13?: string;
  isbn10?: string;
  knownIsbns?: string[];
  editionsCatalog?: EditionCatalogEntry[];
  type: 'edition' | 'work' | 'unknown';
  isHorsSerie?: boolean;
  horsSerieLabel?: string;
  isIntegral?: boolean;
  integralMetadata?: IntegralMetadata;
  parentIntegrals?: ParentIntegralRef[];
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
  updatedAt?: number; // Horodatage pour le système de péremption du cache (TTL)
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
  coverFallbackUrls?: string[];
  ownershipStatus: 'owned' | 'wish' | 'none';
  loan?: LoanRecord; // AJOUT : Attribut contextuel optionnel pour porter le prêt local
  isLocallyEdited?: boolean; // FLAG : Indique que le livre a été édité localement pour éviter l'écrasement par la tâche de fond
}

/**
 * Structure pour le carnet de prêt local
 */
export interface LoanRecord {
  uri: string;
  friendName: string;
  loanDate: number;
  itemId?: string; // Sauvegarde de l'ID physique pour fiabiliser la synchro
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
  layer2Status?: string;
  ownedIntegralMatches?: ParentIntegralRef[];
  includedOwnedWorkIds?: string[];
  v4Notice?: string;
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

// ============================================================================
// TYPES STRICTS POUR L'OPTIMISTIC UI (Remplacement des "any")
// ============================================================================

export interface LendPayload {
  friendName: string;
}

export interface RemoveInventoryPayload {
  itemId?: string;
}

// Le payload peut être soit vide (pour un retour, ajout wishlist, etc.), soit contenir les infos du prêt/suppression
export type QueueActionPayload = LendPayload | RemoveInventoryPayload | Record<string, never> | undefined;

/**
 * Métadonnées structurées d'un livre provenant d'une source externe
 */
export interface ExternalBookMetadata {
  isbn: string;
  title: string;
  authors: string[];
  publisher?: string;
  publishDate?: string;
  pageCount?: number;
  coverUrl?: string;
  coverFallbackUrls?: string[];
  series?: string;
  seriesNumber?: string;
  collection?: string;
  isIntegral?: boolean;
  genres?: string[];
  rawSubjects?: string[];
  deweyCode?: string;
}