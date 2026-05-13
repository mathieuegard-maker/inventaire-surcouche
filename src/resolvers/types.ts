// src/resolvers/types.ts

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
  coverUrl?: string; // Remplacement de 'image' par 'coverUrl'
  localCover?: string; // Ajout : Stockage Base64 pour le hors-ligne
  language?: string;
  pageCount?: number;
  publishDate?: string;
  format?: string;
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

  // Ajout : Statut de possession centralisé pour le Double Check
  ownershipStatus: 'owned' | 'wish' | 'none';
}

export interface InventoryItem {
  _id?: string;
  entity: string; // Utilisation de la vraie clé API de l'Inventaire
  status: 'owned' | 'wishlist' | 'loaned' | 'sold';
  state?: 'new' | 'good' | 'damaged';
  loanTo?: string;
  dateAdded: string;
  personalNote?: string;
}