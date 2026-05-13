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

/**
 * Analyse détaillée de la possession (Double Check)
 */
export interface OwnershipAnalysis {
  isEditionOwned: boolean;    // Possède-t-on cet ISBN précis ?
  isWorkOwned: boolean;       // Possède-t-on l'œuvre (peu importe l'édition) ?
  isWished: boolean;          // Est-ce déjà en Wishlist ?
  duplicateEdition?: HumanizedBook; // Si on a déjà l'œuvre, quelle est l'édition possédée ?
}

/**
 * Contexte complet de la série
 */
export interface SeriesContext {
  id?: string;
  name?: string;
  tomes: HumanizedBook[];     // Liste de tous les tomes avec leurs statuts
  isComplete: boolean;        // Possède-t-on déjà tous les tomes ?
  ownedCount: number;         // Nombre de tomes possédés
}

/**
 * Indicateurs pour l'interface utilisateur
 */
export interface UIFlags {
  showAddButton: boolean;     // Afficher le bouton d'ajout à l'inventaire
  showWishButton: boolean;    // Afficher le bouton Wishlist
  hasBulkActions: boolean;    // La série permet-elle des actions groupées ?
  alertDuplicate: boolean;    // Faut-il afficher l'alerte de doublon d'œuvre ?
}

/**
 * RÉPONSE GLOBALE DE L'ORCHESTRATEUR (SearchService)
 * C'est le "paquet" de données final envoyé au Frontend
 */
export interface SearchResponse {
  mainBook: HumanizedBook;    // Le livre principal scanné
  ownership: OwnershipAnalysis;
  series?: SeriesContext;
  ui: UIFlags;
  source: 'cache' | 'network'; // Origine de la donnée pour le debug
}