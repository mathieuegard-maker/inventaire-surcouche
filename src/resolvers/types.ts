// src/resolvers/types.ts

/**
 * Informations de base communes à tous les états du livre
 */
export interface BaseBook {
  uri: string; // inv:xxx ou wd:Qxxx
  workUri?: string; // NOUVEAU : Lien vers l'œuvre parente
  isbn13?: string;
  isbn10?: string;
  type: 'edition' | 'work' | 'unknown';
  
  // Contenu
  title: string;
  subtitle?: string;
  originalTitle?: string; // Pour les Mangas/Comics
  description?: string;
  image?: string;
  language?: string;
  
  // Physique
  pageCount?: number;
  publishDate?: string;
  format?: string; // Relié, Broché, Deluxe
}

/**
 * Données brutes (Codes URIs) extraites après le Mapping
 */
export interface RawBook extends BaseBook {
  authorIds: string[];
  illustratorIds: string[];
  scriptwriterIds: string[];
  publisherId?: string;
  seriesId?: string;
  seriesNumber?: string;
  genreIds: string[]; // Pour classer par "Science-fiction", "Western", etc.
  collectionId?: string; // Ex: "La Pléiade" ou "Bibliothèque verte"
}

/**
 * Données lisibles par l'humain après passage dans l'Humanizer
 */
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
}

/**
 * REPRÉSENTATION DE TON EXEMPLAIRE PHYSIQUE (Pour le module Inventaire/Prêts)
 * C'est ici qu'on gérera si le livre est à toi, sa note, et s'il est prêté.
 */
export interface InventoryItem {
  id: string; // L'ID de l'item dans TON inventaire
  entityUri: string; // Lien vers le HumanizedBook
  status: 'owned' | 'wishlist' | 'loaned' | 'sold';
  state?: 'new' | 'good' | 'damaged'; // État physique
  loanTo?: string; // Nom de l'ami (ton fameux fichier JSON)
  dateAdded: string;
  personalNote?: string;
}